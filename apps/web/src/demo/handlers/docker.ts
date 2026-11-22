import type { components as A } from '@/api/generated/admin/schema';
import type { DemoDb } from '../db';
import { page } from '../list';
import { ok, on, problem, type Ctx, type Reply } from '../router';
import { canSeeServer, visibility } from '../scope';
import { actorRef, startJob } from './writes';

type S = A['schemas'];
type Validation = S['ComposeValidation'];
type Finding = S['ComposeFinding'];
type Project = S['ComposeProject'];
type Override = { rule: string; reason: string };

const isReply = (x: unknown): x is Reply =>
  typeof x === 'object' && x !== null && 'status' in x && !('uuid' in x) && !('ok' in x);
const ref = (s: { uuid: string; name: string }) => ({ uuid: s.uuid, name: s.name });
const invalid = (detail: string) =>
  problem(422, 'validation_failed', 'Dữ liệu không hợp lệ', detail);
const SA_ONLY = (ctx: Ctx) =>
  ctx.actor.role === 'SUPER_ADMIN'
    ? null
    : problem(403, 'forbidden', 'Chỉ Super Admin được thực hiện thao tác này');

function serverOf(ctx: Ctx, id = ctx.params.id): S['Server'] | Reply {
  const v = visibility(ctx.db, ctx.actor);
  const s = ctx.db.data.servers.find((x) => x.uuid === id);
  return s && canSeeServer(v, s.uuid) ? s : problem(404, 'not_found', 'Không tìm thấy server');
}

function perServer<T>(db: DemoDb, key: string, server: string): T[] {
  const k = `${key}@${server}`;
  db.data[k] ??= structuredClone(db.data[key]);
  return db.data[k] as T[];
}

/** Trạng thái Docker của từng server: dataset có srv-hn-01 (đã bật), server khác coi như chưa cài. */
export function dockerHost(db: DemoDb, s: S['Server']): S['DockerHost'] {
  const k = `docker_host@${s.uuid}`;
  if (!db.data[k]) {
    const hosts = db.data.docker_hosts as S['DockerHost'][];
    const own = hosts.find((h) => h.server.uuid === s.uuid);
    const tpl = hosts.find((h) => h.state === 'not_installed') as S['DockerHost'];
    db.data[k] = structuredClone(own ?? { ...tpl, server: ref(s) });
  }
  return db.data[k] as S['DockerHost'];
}

// ----------------------------------------------------------------- validator (mô phỏng D-96)
/** Rule chặn và có cho ghi đè hay không (khớp validator Go của agent ở 10.3). */
const RULES: Record<string, { overridable: boolean }> = {
  privileged: { overridable: true },
  cap_add: { overridable: true },
  bind_mount: { overridable: true },
  bind_mount_system: { overridable: false },
  docker_socket: { overridable: false },
  host_network: { overridable: false },
  host_pid: { overridable: false },
  devices: { overridable: true },
  services: { overridable: false },
};
const CAP_ALLOW = new Set(['NET_BIND_SERVICE', 'CHOWN', 'SETUID', 'SETGID']);
const SYSTEM_PATHS = ['/', '/etc', '/root', '/boot', '/proc', '/sys', '/dev', '/var/lib/docker'];

interface Block {
  name: string;
  lines: string[];
}
/** Tách các service dưới `services:` (đủ cho YAML thụt 2 khoảng trắng của demo). */
function serviceBlocks(yaml: string): Block[] {
  const lines = yaml.split('\n');
  const out: Block[] = [];
  let inServices = false;
  let cur: Block | null = null;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inServices = false;
      cur = null;
      continue;
    }
    if (!inServices) continue;
    const m = /^ {2}([a-zA-Z0-9_.-]+):\s*$/.exec(line);
    if (m) {
      cur = { name: m[1] as string, lines: [] };
      out.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  return out;
}

/** Danh sách con (`- x`) ngay dưới khóa `key:` của service. */
function listUnder(b: Block, key: string): string[] {
  const out: string[] = [];
  let on = false;
  for (const l of b.lines) {
    if (new RegExp(`^ {4}${key}:\\s*$`).test(l)) {
      on = true;
      continue;
    }
    if (on && /^ {6}- /.test(l)) {
      out.push(
        l
          .replace(/^ {6}- /, '')
          .trim()
          .replace(/^["']|["']$/g, ''),
      );
      continue;
    }
    if (on && /^ {4}\S/.test(l)) on = false;
  }
  const inline = b.lines.find((l) => new RegExp(`^ {4}${key}:\\s*\\[`).test(l));
  if (inline) {
    const body = inline.slice(inline.indexOf('[') + 1, inline.lastIndexOf(']'));
    out.push(
      ...body
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean),
    );
  }
  return out;
}
const scalar = (b: Block, key: string) =>
  b.lines
    .find((l) => new RegExp(`^ {4}${key}:\\s*\\S`).test(l))
    ?.replace(new RegExp(`^ {4}${key}:\\s*`), '')
    .trim()
    .replace(/^["']|["']$/g, '');

export function validateCompose(
  yaml: string,
  overrides: Override[],
  opts: { actor: Ctx['actor']; at: string; nextPort: number },
): { v: Validation; ports: Project['ports']; services: number } {
  const findings: Finding[] = [];
  const rewrites: Validation['rewrites'] = [];
  const ports: Project['ports'] = [];
  const add = (
    rule: string,
    severity: Finding['severity'],
    service: string | null,
    path: string,
    message: string,
  ) =>
    findings.push({
      rule,
      severity,
      service,
      path,
      message,
      overridable: severity === 'error' ? (RULES[rule]?.overridable ?? false) : false,
    });
  const blocks = serviceBlocks(yaml);
  if (blocks.length === 0)
    add('services', 'error', null, 'services', 'Thiếu khóa services: hoặc không có service nào');
  let port = opts.nextPort;
  let out = yaml;
  for (const b of blocks) {
    const p = `services.${b.name}`;
    if (scalar(b, 'privileged') === 'true')
      add(
        'privileged',
        'error',
        b.name,
        `${p}.privileged`,
        'privileged: true cho container toàn quyền trên host',
      );
    if (scalar(b, 'network_mode') === 'host')
      add(
        'host_network',
        'error',
        b.name,
        `${p}.network_mode`,
        'network_mode: host bỏ qua cô lập mạng và chain DOCKER-USER',
      );
    if (scalar(b, 'pid') === 'host')
      add(
        'host_pid',
        'error',
        b.name,
        `${p}.pid`,
        'pid: host cho container thấy mọi tiến trình trên host',
      );
    listUnder(b, 'cap_add').forEach((c, i) => {
      if (!CAP_ALLOW.has(c.toUpperCase()))
        add(
          'cap_add',
          'error',
          b.name,
          `${p}.cap_add[${i}]`,
          `cap_add ${c} ngoài allowlist (NET_BIND_SERVICE, CHOWN, SETUID, SETGID)`,
        );
    });
    if (listUnder(b, 'devices').length > 0)
      add('devices', 'error', b.name, `${p}.devices`, 'Truy cập thiết bị của host (devices)');
    listUnder(b, 'volumes').forEach((v, i) => {
      const host = v.split(':')[0] ?? '';
      if (!host.startsWith('/') && !host.startsWith('.')) return;
      const path = `${p}.volumes[${i}]`;
      if (host.includes('docker.sock'))
        add(
          'docker_socket',
          'error',
          b.name,
          path,
          `Bind mount ${host} cho container điều khiển Docker`,
        );
      else if (SYSTEM_PATHS.some((s) => host === s || (s !== '/' && host.startsWith(`${s}/`))))
        add('bind_mount_system', 'error', b.name, path, `Bind mount thư mục hệ thống ${host}`);
      else
        add(
          'bind_mount',
          'error',
          b.name,
          path,
          `Bind mount ${host} từ host: dùng named volume thay thế`,
        );
    });
    listUnder(b, 'ports').forEach((spec, i) => {
      const parts = spec.split(':');
      const [cport, proto = 'tcp'] = (parts.at(-1) ?? '').split('/');
      if (parts.length === 3 && parts[0] === '127.0.0.1' && Number(parts[1]) >= 20000) {
        ports.push({
          service: b.name,
          container_port: Number(cport),
          host_port: Number(parts[1]),
          protocol: proto === 'udp' ? 'udp' : 'tcp',
        });
        return;
      }
      const after = `127.0.0.1:${port}:${cport}${proto === 'udp' ? '/udp' : ''}`;
      rewrites.push({ service: b.name, path: `${p}.ports[${i}]`, before: spec, after });
      ports.push({
        service: b.name,
        container_port: Number(cport),
        host_port: port,
        protocol: proto === 'udp' ? 'udp' : 'tcp',
      });
      out = out.replace(
        new RegExp(`(- )["']?${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["']?`),
        `$1"${after}"`,
      );
      port += 1;
    });
    if (!scalar(b, 'mem_limit')) {
      add(
        'missing_limits',
        'warning',
        b.name,
        p,
        'Thiếu mem_limit: sẽ tự thêm 512m theo mặc định server',
      );
      rewrites.push({ service: b.name, path: `${p}.mem_limit`, before: null, after: '512m' });
      out = out.replace(new RegExp(`^( {2}${b.name}:\\s*)$`, 'm'), `$1\n    mem_limit: 512m`);
    }
    if (!scalar(b, 'image'))
      add(
        'image',
        'warning',
        b.name,
        `${p}.image`,
        'Không có image: build tại chỗ không được hỗ trợ',
      );
  }
  const given = overrides.filter((o) =>
    findings.some((f) => f.rule === o.rule && f.severity === 'error' && f.overridable),
  );
  const applied = given.map((o) => ({
    rule: o.rule,
    reason: o.reason,
    by: actorRef({ actor: opts.actor } as Ctx),
    at: opts.at,
  }));
  const blocking = findings.filter(
    (f) => f.severity === 'error' && !applied.some((o) => o.rule === f.rule),
  );
  const okv = blocking.length === 0;
  return {
    v: { ok: okv, findings, rewrites, overrides: applied, validated_yaml: okv ? out : null },
    ports,
    services: blocks.length,
  };
}

/** Kiểm override gửi lên: chỉ SUPER_ADMIN, lý do ≥ 10 ký tự, rule phải ghi đè được. */
function checkOverrides(
  ctx: Ctx,
  overrides: Override[] | undefined,
  strict: boolean,
): Reply | null {
  if (!overrides || overrides.length === 0) return null;
  if (ctx.actor.role !== 'SUPER_ADMIN')
    return problem(403, 'forbidden', 'Chỉ Super Admin được ghi đè lỗi compose');
  for (const o of overrides) {
    if (!(o.rule in RULES)) return invalid(`Rule không tồn tại: ${o.rule}`);
    if (!RULES[o.rule]?.overridable) return invalid(`Rule ${o.rule} không thể ghi đè`);
    if (strict && (o.reason ?? '').trim().length < 10)
      return invalid(`Lý do ghi đè ${o.rule} cần tối thiểu 10 ký tự`);
  }
  return null;
}

/** Cổng tiếp theo còn trống trong dải 20000–29999 của server. */
function nextPort(db: DemoDb, server: string): number {
  const used = (db.data.compose as Project[])
    .filter((p) => p.server.uuid === server)
    .flatMap((p) => p.ports.map((x) => x.host_port));
  let p = 20041;
  while (used.includes(p)) p++;
  return p;
}

function revisionsOf(db: DemoDb, p: Project): S['ComposeRevision'][] {
  const k = `compose_revisions@${p.uuid}`;
  if (!db.data[k]) {
    const first = (db.data.compose as Project[])[0];
    db.data[k] =
      first && first.uuid === p.uuid
        ? structuredClone(db.data.compose_revisions)
        : [
            {
              number: p.revision,
              compose_yaml: p.compose_yaml,
              validated_yaml: p.validation.validated_yaml,
              ok: p.validation.ok,
              findings: p.validation.findings.length,
              overrides: p.validation.overrides.length,
              created_by: null,
              created_at: p.updated_at,
              current: true,
            },
          ];
  }
  return db.data[k] as S['ComposeRevision'][];
}

/** Lưu revision mới (hiện hành) cho project. */
export function pushRevision(db: DemoDb, ctx: Ctx, p: Project, fresh = false) {
  if (fresh) db.data[`compose_revisions@${p.uuid}`] = [];
  const revs = revisionsOf(db, p);
  for (const r of revs) r.current = false;
  revs.unshift({
    number: p.revision,
    compose_yaml: p.compose_yaml,
    validated_yaml: p.validation.validated_yaml,
    ok: p.validation.ok,
    findings: p.validation.findings.length,
    overrides: p.validation.overrides.length,
    created_by: actorRef(ctx),
    created_at: db.now(),
    current: true,
  });
}

const volumesIn = (yaml: string) => {
  const m = /^volumes:\s*\n((?: {2}.+\n?)*)/m.exec(yaml);
  return m
    ? [...(m[1] ?? '').matchAll(/^ {2}([a-zA-Z0-9_.-]+):/gm)].map((x) => x[1] as string)
    : [];
};
const imagesIn = (yaml: string): Project['images'] =>
  serviceBlocks(yaml).flatMap((b) => {
    const image = scalar(b, 'image');
    if (!image) return [];
    const digest = `sha256:${Array.from(image)
      .reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
      .toString(16)
      .padStart(12, '0')
      .slice(0, 12)}`;
    return [
      {
        service: b.name,
        image,
        digest,
        latest_digest: digest,
        update_available: false,
        rollback_available: false,
      },
    ];
  });

// ----------------------------------------------------------------- đăng ký handler
export function registerDocker() {
  // --- Docker host ---
  on('get', '/api/v1/admin/servers/{id}/docker', (ctx) => {
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    return ok(dockerHost(ctx.db, s));
  });
  on('post', '/api/v1/admin/servers/{id}/docker:enable', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const h = dockerHost(ctx.db, s);
    if (h.state === 'enabled' || h.state === 'installing')
      return problem(409, 'conflict', 'Docker đã được bật hoặc đang cài trên server này');
    h.state = 'installing';
    return startJob(ctx, {
      type: 'docker.enable',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['software.install', 'docker.host.configure', 'docker.firewall.sync'],
      server: ref(s),
      onDone: (db) => {
        const tpl = (db.data.docker_hosts as S['DockerHost'][]).find((x) => x.state === 'enabled');
        Object.assign(h, structuredClone(tpl), {
          server: ref(s),
          state: 'enabled',
          docker_group_members: [],
          firewall: { synced_at: db.now(), open_ports: [] },
          ports_allocated: 0,
          counts: { containers: 0, running: 0, images: 0, volumes: 0, projects: 0 },
          observed_at: db.now(),
        });
        for (const k of ['containers', 'docker_images', 'docker_volumes', 'docker_networks'])
          db.data[`${k}@${s.uuid}`] =
            k === 'docker_networks'
              ? (db.data.docker_networks as S['DockerNetwork'][]).filter((n) =>
                  ['bridge', 'host', 'none'].includes(n.name),
                )
              : [];
        const sw = perServer<S['Software']>(db, 'software', s.uuid).find((x) => x.key === 'docker');
        if (sw) {
          sw.state = 'installed';
          sw.installed_version = sw.latest_version;
        }
      },
    });
  });
  on('post', '/api/v1/admin/servers/{id}/docker:sync-firewall', (ctx) => {
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const h = dockerHost(ctx.db, s);
    if (h.state !== 'enabled')
      return problem(409, 'conflict', 'Docker chưa được bật trên server này');
    return startJob(ctx, {
      type: 'docker.firewall_sync',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['docker.firewall.sync'],
      server: ref(s),
      onDone: (db) => {
        h.firewall.synced_at = db.now();
        const c = h.checks.find((x) => x.key === 'docker_user_chain');
        if (c) {
          c.ok = true;
          c.detail = `DOCKER-USER: ${h.firewall.open_ports.length} cổng mở, còn lại DROP từ eth0`;
        }
      },
    });
  });
  on('post', '/api/v1/admin/servers/{id}/docker/images:prune', (ctx) => {
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const imgs = perServer<S['DockerImage']>(ctx.db, 'docker_images', s.uuid);
    const victims = imgs.filter((i) => i.dangling && !i.in_use && !i.rollback_of);
    if (victims.length === 0) return problem(409, 'conflict', 'Không có image nào để dọn');
    return startJob(ctx, {
      type: 'docker.image_prune',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['docker.image.prune'],
      server: ref(s),
      changes: { removed: victims.length },
      onDone: (db) => {
        db.data[`docker_images@${s.uuid}`] = imgs.filter((i) => !victims.includes(i));
      },
    });
  });
  on('delete', '/api/v1/admin/servers/{id}/docker/volumes/{volume}', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const vols = perServer<S['DockerVolume']>(ctx.db, 'docker_volumes', s.uuid);
    const v = vols.find((x) => x.name === ctx.params.volume);
    if (!v) return problem(404, 'not_found', 'Không tìm thấy volume');
    if (v.in_use)
      return problem(
        409,
        'resource_locked',
        'Volume đang được dùng',
        `Đang dùng bởi: ${v.used_by.join(', ')}`,
      );
    return startJob(ctx, {
      type: 'docker.volume_remove',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['docker.volume.remove'],
      server: ref(s),
      changes: { volume: v.name },
      onDone: (db) => {
        db.data[`docker_volumes@${s.uuid}`] = vols.filter((x) => x !== v);
      },
    });
  });

  // --- Compose: kiểm tra, revision, image ---
  on('post', '/api/v1/admin/compose-projects:validate', (ctx) => {
    const b = (ctx.body ?? {}) as {
      server_uuid?: string;
      compose_yaml?: string;
      overrides?: Override[];
    };
    if (!b.server_uuid) return invalid('Chọn server.');
    const s = serverOf(ctx, b.server_uuid);
    if (isReply(s)) return s;
    if (dockerHost(ctx.db, s).state !== 'enabled')
      return problem(409, 'conflict', 'Docker chưa được bật trên server này');
    if (typeof b.compose_yaml !== 'string' || b.compose_yaml.length > 262144)
      return invalid('compose.yaml bắt buộc, tối đa 256 KB.');
    const deny = checkOverrides(ctx, b.overrides, false);
    if (deny) return deny;
    const r = validateCompose(b.compose_yaml, b.overrides ?? [], {
      actor: ctx.actor,
      at: ctx.db.now(),
      nextPort: nextPort(ctx.db, s.uuid),
    });
    return ok(r.v);
  });
  const composeOf = (ctx: Ctx): Project | Reply => {
    const v = visibility(ctx.db, ctx.actor);
    const c = (ctx.db.data.compose as Project[]).find((x) => x.uuid === ctx.params.id);
    return c && canSeeServer(v, c.server.uuid)
      ? c
      : problem(404, 'not_found', 'Không tìm thấy compose project');
  };
  on('get', '/api/v1/admin/compose-projects/{id}/revisions', (ctx) => {
    const c = composeOf(ctx);
    if (isReply(c)) return c;
    return page(ctx, revisionsOf(ctx.db, c));
  });
  for (const action of ['update-images', 'rollback-images'] as const) {
    on('post', `/api/v1/admin/compose-projects/{id}:${action}`, (ctx) => {
      const c = composeOf(ctx);
      if (isReply(c)) return c;
      const want = ((ctx.body ?? {}) as { services?: string[] }).services ?? [];
      const pick = c.images.filter(
        (i) =>
          (want.length === 0 || want.includes(i.service)) &&
          (action === 'update-images' ? i.update_available : i.rollback_available),
      );
      if (pick.length === 0)
        return problem(
          409,
          'conflict',
          action === 'update-images'
            ? 'Không có image nào có bản mới'
            : 'Không có bản image cũ để quay lại',
        );
      return startJob(ctx, {
        type: `compose.${action.replace('-', '_')}`,
        resource: { type: 'compose_project', uuid: c.uuid },
        ops: [action === 'update-images' ? 'docker.image.update' : 'docker.image.rollback'],
        server: c.server,
        changes: { services: pick.map((i) => i.service) },
        onDone: (db) => {
          for (const i of pick) {
            const from = i.digest;
            if (action === 'update-images') {
              i.digest = i.latest_digest ?? i.digest;
              i.update_available = false;
              i.rollback_available = true;
            } else {
              i.latest_digest = i.digest;
              i.update_available = true;
              i.rollback_available = false;
            }
            c.last_image_update = {
              state: action === 'update-images' ? 'succeeded' : 'rolled_back',
              service: i.service,
              from_digest: from,
              to_digest: i.digest,
              reason: action === 'update-images' ? null : 'Quay lại thủ công',
              at: db.now(),
            };
          }
          c.updated_at = db.now();
        },
      });
    });
  }
  on('get', '/api/v1/admin/compose-templates', (ctx) =>
    page(ctx, ctx.db.data.compose_templates as S['ComposeTemplate'][]),
  );

  // --- Registry: kiểm đăng nhập (mật khẩu qua vault của agent, không vào job) ---
  on('post', '/api/v1/admin/registries/{id}:test', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const r = (ctx.db.data.registries as S['Registry'][]).find((x) => x.uuid === ctx.params.id);
    if (!r) return problem(404, 'not_found', 'Không tìm thấy registry');
    const srv = ctx.db.data.servers[0] as S['Server'];
    return startJob(ctx, {
      type: 'registry.test',
      resource: { type: 'registry', uuid: r.uuid },
      ops: ['docker.registry.login'],
      server: ref(srv),
      onDone: (db) => {
        const bad = r.url.endsWith('.local');
        r.last_test = {
          ok: !bad,
          message: bad ? '401 Unauthorized: mật khẩu sai hoặc hết hạn' : 'Đăng nhập thành công',
          at: db.now(),
        };
      },
    });
  });

  // --- Cập nhật hệ điều hành tự động (unattended-upgrades, không reboot) ---
  const osOf = (db: DemoDb, s: S['Server']) => {
    const k = `os_updates@${s.uuid}`;
    db.data[k] ??= structuredClone(db.data.os_updates);
    return db.data[k] as S['OsAutoUpdates'];
  };
  on('get', '/api/v1/admin/servers/{id}/os-updates', (ctx) => {
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    return ok(osOf(ctx.db, s));
  });
  on('put', '/api/v1/admin/servers/{id}/os-updates', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const b = (ctx.body ?? {}) as Partial<S['OsAutoUpdatesInput']>;
    if (typeof b.enabled !== 'boolean') return invalid('enabled bắt buộc (true/false).');
    const o = osOf(ctx.db, s);
    return startJob(ctx, {
      type: 'software.os_updates',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['os.auto_updates'],
      server: ref(s),
      changes: { enabled: b.enabled, security_only: b.security_only ?? o.security_only },
      onDone: (db) => {
        o.enabled = b.enabled as boolean;
        if (typeof b.security_only === 'boolean') o.security_only = b.security_only;
        o.auto_reboot = false;
        o.updated_at = db.now();
      },
    });
  });
}

/** Tạo/sửa project: chạy validator, chặn khi còn lỗi (422 kèm findings), lưu revision. */
export function composeWrite(
  ctx: Ctx,
  srv: S['Server'],
  yaml: string,
  overrides: Override[] | undefined,
): Reply | ReturnType<typeof validateCompose> {
  if (dockerHost(ctx.db, srv).state !== 'enabled')
    return problem(409, 'conflict', 'Docker chưa được bật trên server này');
  const deny = checkOverrides(ctx, overrides, true);
  if (deny) return deny;
  const r = validateCompose(yaml, overrides ?? [], {
    actor: ctx.actor,
    at: ctx.db.now(),
    nextPort: nextPort(ctx.db, srv.uuid),
  });
  if (!r.v.ok) {
    const n = r.v.findings.filter(
      (f) => f.severity === 'error' && !r.v.overrides.some((o) => o.rule === f.rule),
    ).length;
    return invalid(`compose.yaml còn ${n} lỗi chặn; chạy Kiểm tra để xem chi tiết.`);
  }
  return r;
}
export { volumesIn, imagesIn };
