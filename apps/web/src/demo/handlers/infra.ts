import type { components as A } from '@/api/generated/admin/schema';
import { onTick, type DemoDb } from '../db';
import { page } from '../list';
import { created, noContent, ok, on, problem, type Ctx, type Reply } from '../router';
import { canSeeServer, visibility } from '../scope';
import { actorRef, startJob } from './writes';

type S = A['schemas'];
type Row = Record<string, unknown>;

/** Thời gian (ms) từ lúc tạo token đăng ký tới khi agent server mới "kết nối" trong demo. */
export const ENROLL_JOIN_MS = 6000;

interface Enrollment {
  name: string;
  role_tags: S['Server']['role_tags'];
  at: number;
  joined: boolean;
}

/**
 * Dữ liệu con của từng server (dịch vụ, phần mềm, tường lửa, container…): dataset chỉ có một bộ
 * mẫu, nên mỗi server nhận một bản sao riêng khi được đọc lần đầu, để thao tác trên server này
 * không ảnh hưởng server khác.
 */
function perServer<T>(db: DemoDb, key: string, server: string): T[] {
  const k = `${key}@${server}`;
  db.data[k] ??= structuredClone(db.data[key]);
  return db.data[k] as T[];
}

function serverOf(ctx: Ctx): S['Server'] | Reply {
  const v = visibility(ctx.db, ctx.actor);
  const s = ctx.db.data.servers.find((x) => x.uuid === ctx.params.id);
  return s && canSeeServer(v, s.uuid) ? s : problem(404, 'not_found', 'Không tìm thấy server');
}
const isReply = (x: unknown): x is Reply =>
  typeof x === 'object' && x !== null && 'status' in x && !('uuid' in x);
const ref = (s: S['Server']) => ({ uuid: s.uuid, name: s.name });
const SA_ONLY = (ctx: Ctx) =>
  ctx.actor.role === 'SUPER_ADMIN'
    ? null
    : problem(403, 'forbidden', 'Chỉ Super Admin được thực hiện thao tác này');
const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const invalid = (detail: string) =>
  problem(422, 'validation_failed', 'Dữ liệu không hợp lệ', detail);

interface FirewallState {
  /** Bộ rule đã xác nhận gần nhất (để hoàn tác). */
  confirmed: S['FirewallRule'][];
  /** Hạn tự hoàn tác (ms epoch) sau khi áp dụng, nếu đang chờ xác nhận. */
  deadline: number | null;
}
function fw(db: DemoDb, server: string): FirewallState {
  const k = `firewall_state@${server}`;
  db.data[k] ??= {
    confirmed: structuredClone(perServer<S['FirewallRule']>(db, 'firewall_rules', server)),
    deadline: null,
  } satisfies FirewallState;
  return db.data[k] as FirewallState;
}

export function registerInfra() {
  // Agent server mới kết nối sau ENROLL_JOIN_MS; safe-apply tường lửa hết hạn thì hoàn tác.
  onTick((db) => {
    const list = (db.data.enrollments ?? []) as Enrollment[];
    for (const e of list) {
      if (e.joined || Date.now() - e.at < ENROLL_JOIN_MS) continue;
      e.joined = true;
      const tpl = db.data.servers[db.data.servers.length - 1] as S['Server'];
      const uuid = db.newUuid();
      const n = db.data.servers.length + 10;
      db.data.servers.push({
        ...structuredClone(tpl),
        uuid,
        name: e.name,
        hostname: `${e.name}.itso.local`,
        ip_addresses: [`10.10.1.${n}`, `203.0.113.${n}`],
        role_tags: e.role_tags,
        agent_connected: true,
        accepting_new_accounts: true,
        account_count: 0,
        resources: { ...tpl.resources, cpu_pct: 3.2, ram_used_mb: 1800, disk_used_mb: 24000 },
        status: 'ready',
        spec_version: 1,
        observed_version: 1,
        drift: null,
        observed_at: db.now(),
        created_at: db.now(),
        updated_at: db.now(),
      });
    }
    for (const s of db.data.servers) {
      const st = db.data[`firewall_state@${s.uuid}`] as FirewallState | undefined;
      if (st?.deadline && Date.now() > st.deadline) {
        st.deadline = null;
        db.data[`firewall_rules@${s.uuid}`] = structuredClone(st.confirmed);
        db.audit({
          actor: { uuid: s.uuid, name: 'itso-agent', email: 'agent@itso.local' },
          action: 'firewall.rollback',
          resource: { type: 'server', uuid: s.uuid },
          server: ref(s),
        });
      }
    }
  });

  // --- Server ---
  on('post', '/api/v1/admin/servers/enrollment-tokens', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const b = (ctx.body ?? {}) as { name?: string; role_tags?: string[]; ttl_min?: number };
    if (!b.name || !NAME.test(b.name)) return invalid('Tên server: chữ thường, số, gạch ngang.');
    if (ctx.db.data.servers.some((s) => s.name === b.name)) {
      return problem(409, 'conflict', 'Tên server đã tồn tại');
    }
    const ttl = b.ttl_min ?? 60;
    if (ttl < 5 || ttl > 1440) return invalid('Thời hạn token từ 5 đến 1440 phút.');
    ctx.db.data.enrollments ??= [];
    (ctx.db.data.enrollments as Enrollment[]).push({
      name: b.name,
      role_tags: (b.role_tags ?? ['web']) as S['Server']['role_tags'],
      at: Date.now(),
      joined: false,
    });
    const tpl = ctx.db.data.enrollment as S['EnrollmentToken'];
    const token = `itso_enr_${ctx.db.newUuid().replace(/-/g, '').slice(-16)}`;
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'server.enroll',
      resource: null,
      changes: { name: b.name },
    });
    return created({
      ...tpl,
      uuid: ctx.db.newUuid(),
      token,
      command: tpl.command.replace(/itso_enr_\w+/, token),
      created_at: ctx.db.now(),
      expires_at: new Date(Date.now() + ttl * 60_000 + 7 * 3600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, '+07:00'),
    });
  });

  on('patch', '/api/v1/admin/servers/{id}', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const b = (ctx.body ?? {}) as Partial<Pick<S['Server'], 'name' | 'role_tags'>> & {
      accepting_new_accounts?: boolean;
    };
    if (b.name !== undefined && !NAME.test(b.name)) return invalid('Tên server không hợp lệ.');
    if (b.name && ctx.db.data.servers.some((x) => x.name === b.name && x.uuid !== s.uuid)) {
      return problem(409, 'conflict', 'Tên server đã tồn tại');
    }
    Object.assign(s, b, { updated_at: ctx.db.now() });
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'server.update',
      resource: { type: 'server', uuid: s.uuid },
      server: ref(s),
      changes: b as Record<string, unknown>,
    });
    return ok(s);
  });

  on('post', '/api/v1/admin/servers/{id}:reboot', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    return startJob(ctx, {
      type: 'server.reboot',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['system.reboot', 'system.ping'],
      server: ref(s),
    });
  });

  const perServerGet: [Parameters<typeof on>[1], string][] = [
    ['/api/v1/admin/servers/{id}/services', 'services'],
    ['/api/v1/admin/servers/{id}/software', 'software'],
    ['/api/v1/admin/servers/{id}/php-versions', 'php_versions'],
    ['/api/v1/admin/servers/{id}/firewall/rules', 'firewall_rules'],
    ['/api/v1/admin/servers/{id}/docker/containers', 'containers'],
    ['/api/v1/admin/servers/{id}/docker/images', 'docker_images'],
    ['/api/v1/admin/servers/{id}/docker/volumes', 'docker_volumes'],
    ['/api/v1/admin/servers/{id}/docker/networks', 'docker_networks'],
  ];
  for (const [path, key] of perServerGet) {
    on('get', path, (ctx) => {
      const s = serverOf(ctx);
      if (isReply(s)) return s;
      const rows = perServer<Row>(ctx.db, key, s.uuid);
      return page(ctx, key === 'firewall_rules' ? [...rows].sort(byPriority) : rows);
    });
  }
  on('get', '/api/v1/admin/servers/{id}/nginx', (ctx) => {
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    ctx.db.data[`nginx@${s.uuid}`] ??= structuredClone(ctx.db.data.nginx_global);
    return ok(ctx.db.data[`nginx@${s.uuid}`]);
  });
  on('patch', '/api/v1/admin/servers/{id}/nginx', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const b = (ctx.body ?? {}) as Partial<S['NginxGlobal']>;
    if (b.worker_processes !== undefined && !/^(auto|[0-9]{1,3})$/.test(b.worker_processes)) {
      return invalid('worker_processes: "auto" hoặc số.');
    }
    if (
      b.worker_connections !== undefined &&
      (b.worker_connections < 256 || b.worker_connections > 65535)
    ) {
      return invalid('worker_connections từ 256 đến 65535.');
    }
    if (
      b.client_max_body_size !== undefined &&
      !/^[0-9]{1,5}[kmg]?$/.test(b.client_max_body_size)
    ) {
      return invalid('client_max_body_size dạng 64m, 1g…');
    }
    return startJob(ctx, {
      type: 'nginx.update',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['nginx.global.apply'],
      server: ref(s),
      changes: b as Record<string, unknown>,
      onDone: (db) => {
        const cur = (db.data[`nginx@${s.uuid}`] ??= structuredClone(db.data.nginx_global));
        Object.assign(cur as object, b, { updated_at: db.now() });
      },
    });
  });

  // --- Dịch vụ, phần mềm ---
  on('post', '/api/v1/admin/servers/{id}/services/{service}:{action}', (ctx) => {
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const { service = '', action = '' } = ctx.params;
    if (!['start', 'stop', 'restart', 'reload'].includes(action)) {
      return invalid('Hành động: start, stop, restart, reload.');
    }
    const rows = perServer<S['ServerService']>(ctx.db, 'services', s.uuid);
    const svc = rows.find((x) => x.name === service);
    if (!svc) return problem(404, 'not_found', 'Dịch vụ không có trong allowlist');
    return startJob(ctx, {
      type: `service.${action}`,
      resource: { type: 'server', uuid: s.uuid },
      ops: ['service.control', 'service.status'],
      server: ref(s),
      changes: { service, action },
      onDone: (db) => {
        svc.active = action !== 'stop';
        if (action !== 'reload') svc.since = action === 'stop' ? null : db.now();
      },
    });
  });

  on('post', '/api/v1/admin/servers/{id}/software/{key}:{action}', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const { key = '', action = '' } = ctx.params;
    if (!['install', 'remove', 'upgrade'].includes(action)) {
      return invalid('Hành động: install, remove, upgrade.');
    }
    const rows = perServer<S['Software']>(ctx.db, 'software', s.uuid);
    const php = /^php(\d\.\d)$/.exec(key);
    const sw = rows.find((x) => x.key === key);
    if (!sw && !php) return problem(404, 'not_found', 'Không có recipe cho phần mềm này');
    if (sw && action === 'install' && sw.state !== 'available') {
      return problem(409, 'conflict', 'Phần mềm đã được cài');
    }
    if (sw && action !== 'install' && sw.state === 'available') {
      return problem(409, 'conflict', 'Phần mềm chưa được cài');
    }
    return startJob(ctx, {
      type: `software.${action}`,
      resource: { type: 'server', uuid: s.uuid },
      ops: php ? ['php.version.install'] : ['software.install', 'service.status'],
      server: ref(s),
      changes: { key, action },
      onDone: (db) => {
        if (php) {
          const versions = perServer<S['PhpVersionInfo']>(db, 'php_versions', s.uuid);
          const v = versions.find((x) => x.version === php[1]);
          if (v) v.installed = action !== 'remove';
          else if (action === 'install') {
            versions.push({
              version: php[1] as string,
              installed: true,
              default: false,
              sites_count: 0,
              extensions: ['intl', 'gd', 'zip'],
            } as S['PhpVersionInfo']);
          }
          return;
        }
        if (!sw) return;
        if (action === 'remove') {
          sw.state = 'available';
          sw.installed_version = null;
        } else {
          sw.state = 'installed';
          sw.installed_version = sw.latest_version;
        }
      },
    });
  });

  // --- Tường lửa (safe-apply) ---
  on('post', '/api/v1/admin/servers/{id}/firewall/rules', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const b = (ctx.body ?? {}) as Partial<S['FirewallRule']>;
    const err = firewallError(b);
    const lock = err ? null : lockoutError(b, s);
    if (lock) return problem(422, 'would_lock_out', 'Sẽ tự khóa mình', lock);
    if (err) return invalid(err);
    fw(ctx.db, s.uuid);
    const rule = {
      uuid: ctx.db.newUuid(),
      priority: b.priority,
      action: b.action,
      direction: b.direction,
      protocol: b.protocol,
      ports: b.protocol === 'icmp' ? null : (b.ports ?? null),
      source: b.source,
      comment: b.comment ?? null,
      enabled: b.enabled ?? true,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    } as S['FirewallRule'];
    perServer<S['FirewallRule']>(ctx.db, 'firewall_rules', s.uuid).push(rule);
    return created(rule);
  });
  on('delete', '/api/v1/admin/servers/{id}/firewall/rules/{rule}', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    fw(ctx.db, s.uuid);
    const rows = perServer<S['FirewallRule']>(ctx.db, 'firewall_rules', s.uuid);
    const i = rows.findIndex((r) => r.uuid === ctx.params.rule);
    if (i < 0) return problem(404, 'not_found', 'Không tìm thấy rule');
    rows.splice(i, 1);
    return noContent();
  });
  on('post', '/api/v1/admin/servers/{id}/firewall:apply', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const sec = (ctx.body as { rollback_after_sec?: number } | undefined)?.rollback_after_sec;
    if (sec === undefined || sec < 30 || sec > 600) {
      return invalid('rollback_after_sec từ 30 đến 600 giây.');
    }
    const st = fw(ctx.db, s.uuid);
    if (st.deadline) return problem(409, 'conflict', 'Đang chờ xác nhận lần áp dụng trước');
    return startJob(ctx, {
      type: 'firewall.apply',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['firewall.apply'],
      server: ref(s),
      changes: { rollback_after_sec: sec },
      onDone: () => {
        st.deadline = Date.now() + sec * 1000;
      },
    });
  });
  on('post', '/api/v1/admin/servers/{id}/firewall:confirm', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const st = fw(ctx.db, s.uuid);
    if (!st.deadline) {
      return problem(409, 'conflict', 'Không có lần áp dụng nào đang chờ xác nhận (đã hoàn tác?)');
    }
    const snapshot = structuredClone(
      perServer<S['FirewallRule']>(ctx.db, 'firewall_rules', s.uuid),
    );
    st.deadline = null;
    st.confirmed = snapshot;
    return startJob(ctx, {
      type: 'firewall.confirm',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['firewall.confirm'],
      server: ref(s),
    });
  });

  // --- Docker ---
  on('post', '/api/v1/admin/servers/{id}/docker/containers/{container}:{action}', (ctx) => {
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const { container = '', action = '' } = ctx.params;
    if (!['start', 'stop', 'restart'].includes(action)) {
      return invalid('Hành động: start, stop, restart.');
    }
    const c = perServer<S['Container']>(ctx.db, 'containers', s.uuid).find(
      (x) => x.id === container || x.name === container,
    );
    if (!c) return problem(404, 'not_found', 'Không tìm thấy container');
    return startJob(ctx, {
      type: `container.${action}`,
      resource: { type: 'server', uuid: s.uuid },
      ops: ['docker.container.control'],
      server: ref(s),
      changes: { container: c.name, action },
      onDone: () => {
        c.state = action === 'stop' ? 'exited' : 'running';
        c.status = action === 'stop' ? 'Exited (0) vừa xong' : 'Up vài giây';
      },
    });
  });
  on('get', '/api/v1/admin/servers/{id}/docker/containers/{container}/logs', (ctx) => {
    const s = serverOf(ctx);
    if (isReply(s)) return s;
    const c = perServer<S['Container']>(ctx.db, 'containers', s.uuid).find(
      (x) => x.id === ctx.params.container,
    );
    if (!c) return problem(404, 'not_found', 'Không tìm thấy container');
    const lines = Math.min(Number(ctx.query.get('lines') ?? 100) || 100, 1000);
    const base = [
      `[${c.name}] khởi động image ${c.image}`,
      `[${c.name}] cấu hình đã nạp`,
      `[${c.name}] sẵn sàng nhận kết nối`,
    ];
    const out = Array.from({ length: Math.min(lines, 40) }, (_, i) =>
      i < 3 ? (base[i] as string) : `[${c.name}] health check ok (${i - 2})`,
    );
    return ok(out);
  });

  // --- Compose ---
  const composeOf = (ctx: Ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const c = (ctx.db.data.compose as S['ComposeProject'][]).find((x) => x.uuid === ctx.params.id);
    return c && canSeeServer(v, c.server.uuid)
      ? c
      : problem(404, 'not_found', 'Không tìm thấy compose project');
  };
  const COMPOSE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
  on('post', '/api/v1/admin/compose-projects', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const b = (ctx.body ?? {}) as {
      server_uuid?: string;
      name?: string;
      compose_yaml?: string;
    };
    const srv = ctx.db.data.servers.find((x) => x.uuid === b.server_uuid);
    if (!srv) return invalid('Chọn server.');
    if (!b.name || !COMPOSE_NAME.test(b.name)) return invalid('Tên project không hợp lệ.');
    if (!b.compose_yaml?.includes('services:')) {
      return invalid('compose.yaml phải có khóa services:.');
    }
    const list = ctx.db.data.compose as S['ComposeProject'][];
    if (list.some((x) => x.name === b.name && x.server.uuid === srv.uuid)) {
      return problem(409, 'conflict', 'Tên project đã có trên server này');
    }
    const uuid = ctx.db.newUuid();
    const services = (b.compose_yaml.match(/^ {2}[a-z0-9_-]+:\s*$/gm) ?? []).length || 1;
    const proj = {
      uuid,
      server: ref(srv),
      name: b.name,
      status: 'stopped',
      services,
      revision: 1,
      validation: { ok: true, warnings: [] },
      compose_yaml: b.compose_yaml,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    } as unknown as S['ComposeProject'];
    list.push(proj);
    return startJob(ctx, {
      type: 'compose.create',
      resource: { type: 'compose_project', uuid },
      ops: ['compose.validate', 'compose.apply', 'compose.up'],
      server: ref(srv),
      changes: { name: b.name },
      onDone: () => {
        proj.status = 'running';
      },
    });
  });
  on('patch', '/api/v1/admin/compose-projects/{id}', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const c = composeOf(ctx);
    if (isReply(c)) return c;
    const b = (ctx.body ?? {}) as { compose_yaml?: string; name?: string };
    if (b.name !== undefined && !COMPOSE_NAME.test(b.name)) return invalid('Tên không hợp lệ.');
    if (b.compose_yaml !== undefined && !b.compose_yaml.includes('services:')) {
      return invalid('compose.yaml phải có khóa services:.');
    }
    return startJob(ctx, {
      type: 'compose.update',
      resource: { type: 'compose_project', uuid: c.uuid },
      ops: ['compose.validate', 'compose.apply'],
      server: c.server,
      onDone: (db) => {
        Object.assign(c, b, { revision: c.revision + 1, updated_at: db.now() });
      },
    });
  });
  on('delete', '/api/v1/admin/compose-projects/{id}', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const c = composeOf(ctx);
    if (isReply(c)) return c;
    return startJob(ctx, {
      type: 'compose.delete',
      resource: { type: 'compose_project', uuid: c.uuid },
      ops: ['compose.down'],
      server: c.server,
      onDone: (db) => {
        const list = db.data.compose as S['ComposeProject'][];
        const i = list.findIndex((x) => x.uuid === c.uuid);
        if (i >= 0) list.splice(i, 1);
      },
    });
  });
  for (const action of ['up', 'down', 'pull', 'validate'] as const) {
    on('post', `/api/v1/admin/compose-projects/{id}:${action}`, (ctx) => {
      const c = composeOf(ctx);
      if (isReply(c)) return c;
      return startJob(ctx, {
        type: `compose.${action}`,
        resource: { type: 'compose_project', uuid: c.uuid },
        ops: [`compose.${action}`],
        server: c.server,
        onDone: () => {
          if (action === 'up') c.status = 'running';
          if (action === 'down') c.status = 'stopped';
          if (action === 'validate') c.validation = { ok: true, warnings: [] };
        },
      });
    });
  }

  // --- Registry ---
  on('post', '/api/v1/admin/registries', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const b = (ctx.body ?? {}) as { name?: string; url?: string; username?: string | null };
    if (!b.name || b.name.length > 80) return invalid('Tên registry bắt buộc (≤ 80 ký tự).');
    if (!b.url || !/^https:\/\/[^\s/]+/.test(b.url))
      return invalid('URL phải bắt đầu bằng https://');
    const reg = {
      uuid: ctx.db.newUuid(),
      name: b.name,
      url: b.url,
      username: b.username ?? null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    } as S['Registry'];
    (ctx.db.data.registries as S['Registry'][]).push(reg);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'registry.create',
      resource: { type: 'registry', uuid: reg.uuid },
    });
    return created(reg);
  });
  on('delete', '/api/v1/admin/registries/{id}', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const list = ctx.db.data.registries as S['Registry'][];
    const i = list.findIndex((x) => x.uuid === ctx.params.id);
    if (i < 0) return problem(404, 'not_found', 'Không tìm thấy registry');
    list.splice(i, 1);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'registry.delete',
      resource: { type: 'registry', uuid: ctx.params.id ?? '' },
    });
    return noContent();
  });

  // --- Terminal (mô phỏng) ---
  on('post', '/api/v1/admin/terminal/sessions', (ctx) => {
    const b = (ctx.body ?? {}) as {
      mode?: 'account' | 'root';
      server_uuid?: string | null;
      hosting_account_uuid?: string | null;
    };
    if (b.mode !== 'account' && b.mode !== 'root') return invalid('mode: account hoặc root.');
    if (b.mode === 'root' && ctx.actor.role !== 'SUPER_ADMIN') {
      return problem(403, 'forbidden', 'Terminal root chỉ dành cho Super Admin');
    }
    const v = visibility(ctx.db, ctx.actor);
    if (b.mode === 'root' && !ctx.db.data.servers.some((s) => s.uuid === b.server_uuid)) {
      return invalid('Chọn server.');
    }
    const acc = ctx.db.data.accounts.find((a) => a.uuid === b.hosting_account_uuid);
    if (b.mode === 'account' && (!acc || !(v.all || v.accounts.has(acc.uuid)))) {
      return invalid('Chọn tài khoản hosting.');
    }
    // Root chỉ khi policy cục bộ của máy chủ cho phép (bật bằng `itso policy set`, D-81).
    const policy = ctx.db.data.terminal_policy as S['TerminalPolicy'] | undefined;
    if (b.mode === 'root' && !policy?.root_enabled) {
      return problem(
        403,
        'forbidden',
        'Policy máy chủ đang tắt terminal root',
        'Bật bằng lệnh `itso policy set terminal.root on` trên máy chủ.',
      );
    }
    const tpl = ctx.db.data.terminal as S['TerminalTicket'];
    const session = ctx.db.newUuid();
    const srv =
      b.mode === 'root'
        ? ctx.db.data.servers.find((x) => x.uuid === b.server_uuid)
        : ctx.db.data.servers.find((x) => x.uuid === acc?.server.uuid);
    const me = ctx.db.data.users.find((u) => u.uuid === ctx.actor.uuid);
    (ctx.db.data.terminal_sessions as S['TerminalSession'][]).unshift({
      uuid: session,
      mode: b.mode,
      unix_user: b.mode === 'root' ? 'root' : (acc?.username ?? 'user'),
      server: { uuid: srv?.uuid ?? '', name: srv?.name ?? '' },
      hosting_account:
        b.mode === 'root' || !acc ? null : { uuid: acc.uuid, username: acc.username },
      opened_by: { uuid: ctx.actor.uuid, name: me?.name ?? '', email: me?.email ?? '' },
      client_ip: '10.10.5.20',
      started_at: ctx.db.now(),
      ended_at: null,
      ended_reason: null,
      recorded: b.mode === 'root' ? (policy?.record_root ?? true) : (policy?.record_user ?? false),
      recording_bytes: 0,
    });
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'terminal.open',
      resource:
        b.mode === 'root'
          ? { type: 'server', uuid: b.server_uuid ?? '' }
          : { type: 'hosting_account', uuid: acc?.uuid ?? '' },
      changes: { mode: b.mode },
    });
    return created({
      ...tpl,
      ticket: `tkt_${ctx.db.newUuid().slice(-12)}`,
      session_uuid: session,
      mode: b.mode,
      unix_user: b.mode === 'root' ? 'root' : (acc?.username ?? 'user'),
      expires_at: new Date(Date.now() + 30_000 + 7 * 3600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, '+07:00'),
    });
  });
}

const byPriority = (a: Row, b: Row) => Number(a.priority) - Number(b.priority);

const CIDR =
  /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(\/(3[0-2]|[12]?\d))?$|^[0-9a-f:]+(\/\d{1,3})?$/i;
const PORTS = /^([0-9]{1,5}(-[0-9]{1,5})?)(,[0-9]{1,5}(-[0-9]{1,5})?)*$/;

/** Kiểm rule tường lửa như backend (FirewallRuleInput). Trả thông báo lỗi hoặc null. */
export function firewallError(b: Partial<S['FirewallRule']>): string | null {
  if (!b.priority || b.priority < 1 || b.priority > 9999) return 'priority từ 1 đến 9999.';
  if (!b.action || !['accept', 'drop', 'reject'].includes(b.action)) return 'action không hợp lệ.';
  if (!b.direction || !['in', 'out'].includes(b.direction)) return 'direction không hợp lệ.';
  if (!b.protocol || !['tcp', 'udp', 'icmp', 'any'].includes(b.protocol)) {
    return 'protocol không hợp lệ.';
  }
  if (!b.source || !CIDR.test(b.source)) return 'source phải là IP hoặc CIDR.';
  if ((b.protocol === 'tcp' || b.protocol === 'udp') && (!b.ports || !PORTS.test(b.ports))) {
    return 'ports dạng 80,443 hoặc 8000-8100.';
  }
  return null;
}

/** IP của phiên hiện tại ở bản demo (khớp `sessions[current]`). */
export const DEMO_CLIENT_IP = '10.10.5.20';
const ipNum = (ip: string) => ip.split('.').reduce((a, x) => a * 256 + Number(x), 0);
function inCidr(ip: string, cidr: string): boolean {
  if (!/^[0-9.]+(\/\d+)?$/.test(cidr)) return false;
  const [base = '', bits = '32'] = cidr.split('/');
  const n = Number(bits);
  const mask = n === 0 ? 0 : 2 ** 32 - 2 ** (32 - n);
  return (ipNum(ip) & mask) >>> 0 === (ipNum(base) & mask) >>> 0;
}
function hitsPort(ports: string | null | undefined, port: number): boolean {
  if (!ports) return true;
  return ports.split(',').some((p) => {
    const [a, b = a] = p.split('-').map(Number) as [number, number?];
    return port >= a && port <= (b ?? a);
  });
}
/**
 * Bất biến chống tự khóa (D-76): rule chặn vào cổng SSH (22) hoặc cổng panel (8443) với nguồn chứa IP của người
 * đang thao tác bị từ chối. Backend và agent kiểm lại cùng quy tắc.
 */
export function lockoutError(b: Partial<S['FirewallRule']>, _s: { uuid: string }): string | null {
  void _s;
  if (b.direction !== 'in' || b.action === 'accept' || b.enabled === false) return null;
  if (b.protocol !== 'tcp' && b.protocol !== 'any') return null;
  if (!b.source || !inCidr(DEMO_CLIENT_IP, b.source)) return null;
  for (const [port, name] of [
    [22, 'SSH'],
    [8443, 'Admin Panel'],
  ] as const) {
    if (hitsPort(b.ports, port)) {
      return `Rule này chặn cổng ${port} (${name}) từ IP hiện tại của bạn (${DEMO_CLIENT_IP}). Thu hẹp nguồn hoặc thêm rule cho phép IP của bạn trước.`;
    }
  }
  return null;
}
