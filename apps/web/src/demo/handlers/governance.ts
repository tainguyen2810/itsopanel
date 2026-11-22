import type { components as A } from '@/api/generated/admin/schema';
import { parseCron } from '@/shared/hosting/cron';
import { toCsv } from '@/shared/lib/csv';
import type { DemoDb } from '../db';
import { get as pick, page } from '../list';
import { created, noContent, ok, on, problem, type Ctx, type Reply } from '../router';
import { canSeeAccount, canSeeServer, scopeRows, visibility } from '../scope';
import { needServer, sshState } from './security';
import { actorRef, startJob } from './writes';

/**
 * Prompt 2.6: bảo mật (SSH, fail2ban, allowlist, sự kiện, quarantine), backup/restore, người dùng
 * (khóa, MFA, phạm vi, impersonate), luật cảnh báo, audit (xuất CSV), thông báo, cài đặt, API token.
 */
type S = A['schemas'];
type User = S['AdminUser'];
type Dest = S['BackupDestination'];
type Policy = S['BackupPolicy'];
type Snapshot = S['BackupSnapshot'];
type Rule = S['AlertRule'];

const P = (p: string) => `/api/v1/admin${p}` as Parameters<typeof on>[1];
const invalid = (detail: string) =>
  problem(422, 'validation_failed', 'Dữ liệu không hợp lệ', detail);
/** 422 gắn vào một trường, như ApiProblem::field của API thật. */
const fieldInvalid = (field: string, message: string): Reply => {
  const r = problem(
    422,
    'validation_failed',
    'Dữ liệu không hợp lệ',
    'Một hoặc nhiều trường không hợp lệ.',
  );
  return { ...r, body: { ...(r.body as object), errors: { [field]: [message] } } };
};
const notFound = (what: string) => problem(404, 'not_found', `Không tìm thấy ${what}`);
const conflict = (detail: string, code = 'conflict') =>
  problem(409, code, 'Xung đột trạng thái', detail);
const isReply = (x: unknown): x is Reply =>
  typeof x === 'object' && x !== null && 'status' in x && !('uuid' in x);
const saOnly = (ctx: Ctx): Reply | null =>
  ctx.actor.role === 'SUPER_ADMIN'
    ? null
    : problem(403, 'forbidden', 'Chỉ Super Admin được thực hiện thao tác này');
const body = <T>(ctx: Ctx) => (ctx.body ?? {}) as Partial<T>;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** If-Match (nếu gửi) phải khớp updated_at hiện tại, ngược lại 412 (khóa lạc quan). */
function precondition(ctx: Ctx, updatedAt: string): Reply | null {
  const want = ctx.request.headers.get('If-Match');
  return want && want.replaceAll('"', '') !== updatedAt
    ? problem(
        412,
        'precondition_failed',
        'Dữ liệu đã bị người khác thay đổi',
        'Tải lại rồi thử lại.',
      )
    : null;
}

const SERVER_HN = (db: DemoDb) => {
  const s = db.data.servers[0];
  return s ? { uuid: s.uuid, name: s.name } : null;
};

// ---------------------------------------------------------------- bảo mật
const GROUP = /^[a-z][a-z0-9-]{0,31}$/;
const CIDR =
  /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(\/([0-9]|[12][0-9]|3[0-2]))?$|^[0-9a-f:]+(\/[0-9]{1,3})?$/i;

function registerSecurity() {
  on('post', P('/security/events/{id}:acknowledge'), (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const e = ctx.db.data.security_events.find((x) => x.uuid === ctx.params.id);
    if (!e || !canSeeServer(v, e.server.uuid)) return notFound('sự kiện bảo mật');
    if (e.acknowledged_at) return conflict('Sự kiện đã được xác nhận.');
    e.acknowledged_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'security_event.acknowledge',
      resource: { type: 'security_event', uuid: e.uuid },
      server: e.server,
    });
    return ok(e);
  });

  on('get', P('/security/ssh'), (ctx) => {
    const deny = saOnly(ctx) ?? needServer(ctx);
    if (deny) return deny;
    return ok(ctx.db.data.ssh_settings as S['SshSettings']);
  });
  on('get', P('/security/fail2ban'), (ctx) => {
    const deny = saOnly(ctx) ?? needServer(ctx);
    if (deny) return deny;
    return ok(ctx.db.data.fail2ban as S['Fail2banSettings']);
  });
  on('patch', P('/security/ssh'), (ctx) => {
    const deny = saOnly(ctx) ?? needServer(ctx);
    if (deny) return deny;
    const cur = ctx.db.data.ssh_settings as S['SshSettings'];
    const pre = precondition(ctx, cur.updated_at);
    if (pre) return pre;
    const b = body<S['SshSettingsPatch']>(ctx);
    const sec = b.rollback_after_sec;
    if (sec === undefined || sec < 30 || sec > 600)
      return invalid('rollback_after_sec từ 30 đến 600 giây.');
    if (sshState(ctx.db).deadline)
      return problem(409, 'conflict', 'Đang chờ xác nhận lần áp dụng SSH trước');
    if (b.password_authentication === false && (cur.admin_keys ?? 0) === 0)
      return problem(
        422,
        'would_lock_out',
        'Sẽ tự khóa mình',
        'Chưa có khóa SSH nào cho user quản trị; thêm khóa trước khi tắt đăng nhập bằng mật khẩu.',
      );
    if (b.port !== undefined && (!Number.isInteger(b.port) || b.port < 1 || b.port > 65535))
      return invalid('Cổng SSH từ 1 đến 65535.');
    if (b.max_auth_tries !== undefined && (b.max_auth_tries < 1 || b.max_auth_tries > 10))
      return invalid('Số lần thử từ 1 đến 10.');
    if (
      b.permit_root_login !== undefined &&
      !['no', 'prohibit-password'].includes(b.permit_root_login)
    )
      return invalid('Root chỉ được "no" hoặc "prohibit-password".');
    if (b.allow_groups !== undefined) {
      if (b.allow_groups.length === 0)
        return invalid('Cần ít nhất một nhóm được SSH, nếu không sẽ tự khóa mình ngoài server.');
      if (!b.allow_groups.every((g) => GROUP.test(g)))
        return invalid('Tên nhóm Linux không hợp lệ.');
    }
    const changes: Record<string, unknown> = {};
    for (const k of [
      'port',
      'password_authentication',
      'permit_root_login',
      'allow_groups',
      'max_auth_tries',
    ] as const) {
      if (b[k] !== undefined) changes[k] = [cur[k], b[k]];
    }
    return startJob(ctx, {
      type: 'security.ssh.update',
      resource: { type: 'server', uuid: SERVER_HN(ctx.db)?.uuid ?? '' },
      ops: ['sshd.config.apply'],
      server: SERVER_HN(ctx.db),
      changes,
      onDone: (db) => {
        const s = db.data.ssh_settings as S['SshSettings'];
        const st = sshState(db);
        st.previous = structuredClone(s);
        st.deadline = Date.now() + sec * 1000;
        const { rollback_after_sec: _r, ...rest } = b;
        void _r;
        Object.assign(s, rest, { updated_at: db.now() });
      },
    });
  });

  on('patch', P('/security/fail2ban'), (ctx) => {
    const deny = saOnly(ctx) ?? needServer(ctx);
    if (deny) return deny;
    const cur = ctx.db.data.fail2ban as S['Fail2banSettings'];
    const pre = precondition(ctx, cur.updated_at);
    if (pre) return pre;
    const b = body<S['Fail2banSettingsPatch']>(ctx);
    for (const j of b.jails ?? []) {
      if (!cur.jails.some((x) => x.name === j.name)) return invalid(`Không có jail "${j.name}".`);
      if (j.bantime_sec < 60 || j.findtime_sec < 60) return invalid('Thời gian tối thiểu 60 giây.');
      if (j.maxretry < 1) return invalid('Số lần thử tối thiểu là 1.');
    }
    return startJob(ctx, {
      type: 'security.fail2ban.update',
      resource: { type: 'server', uuid: SERVER_HN(ctx.db)?.uuid ?? '' },
      ops: ['fail2ban.apply'],
      server: SERVER_HN(ctx.db),
      changes: { ...(b.enabled === undefined ? {} : { enabled: [cur.enabled, b.enabled] }) },
      onDone: (db) => {
        const s = db.data.fail2ban as S['Fail2banSettings'];
        if (b.enabled !== undefined) s.enabled = b.enabled;
        for (const j of b.jails ?? []) {
          const x = s.jails.find((y) => y.name === j.name);
          // banned_count do fail2ban báo về, không ghi từ form.
          if (x) Object.assign(x, { ...j, banned_count: x.banned_count });
        }
        s.updated_at = db.now();
      },
    });
  });

  on('put', P('/security/ip-allowlist'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const cur = ctx.db.data.ip_allowlist as S['IpAllowlist'];
    const b = body<S['IpAllowlist']>(ctx);
    if (!Array.isArray(b.entries)) return invalid('Thiếu danh sách entries.');
    if (b.updated_at && b.updated_at !== cur.updated_at)
      return conflict('Danh sách đã bị người khác thay đổi. Tải lại rồi thử lại.');
    const seen = new Set<string>();
    for (const e of b.entries) {
      if (!CIDR.test(e.cidr ?? '')) return invalid(`"${e.cidr}" không phải IP/CIDR hợp lệ.`);
      if ((e.note ?? '').length > 120) return invalid('Ghi chú tối đa 120 ký tự.');
      if (seen.has(e.cidr)) return invalid(`"${e.cidr}" bị trùng.`);
      seen.add(e.cidr);
    }
    if (b.entries.length === 0)
      return invalid('Cần ít nhất một dải IP; danh sách rỗng sẽ khóa mọi người khỏi Admin Panel.');
    const before = cur.entries.map((e) => e.cidr);
    cur.entries = b.entries.map((e) => ({ cidr: e.cidr, note: e.note ?? '' }));
    cur.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'security.allowlist.update',
      resource: null,
      changes: { entries: [before, cur.entries.map((e) => e.cidr)] },
    });
    return ok(cur);
  });

  on('post', P('/security/quarantine/{id}:restore'), (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const q = (ctx.db.data.quarantine as S['QuarantineItem'][]).find(
      (x) => x.uuid === ctx.params.id,
    );
    if (!q || !canSeeAccount(v, q.hosting_account.uuid)) return notFound('file cách ly');
    if (q.restored_at) return conflict('File đã được khôi phục trước đó.');
    const a = ctx.db.data.accounts.find((x) => x.uuid === q.hosting_account.uuid);
    return startJob(ctx, {
      type: 'security.quarantine.restore',
      resource: { type: 'hosting_account', uuid: q.hosting_account.uuid },
      ops: ['malware.restore'],
      server: a?.server ?? null,
      changes: { path: q.original_path },
      onDone: (db) => {
        q.restored_at = db.now();
      },
    });
  });
}

// ---------------------------------------------------------------- backup & restore
const REQUIRED_CONFIG: Record<Dest['type'], string[]> = {
  local: [],
  sftp: ['host', 'path'],
  s3: ['endpoint', 'bucket'],
  rest: ['url'],
};

function destError(b: Partial<S['BackupDestinationInput']>, partial = false): string | null {
  if (!partial || b.name !== undefined) {
    if (!b.name?.trim() || b.name.length > 80) return 'Tên đích từ 1 đến 80 ký tự.';
  }
  if (!partial && (!b.type || !(b.type in REQUIRED_CONFIG))) return 'Chọn loại đích.';
  if (b.type && b.config) {
    for (const k of REQUIRED_CONFIG[b.type]) {
      if (!b.config[k]?.trim()) return `Thiếu cấu hình "${k}".`;
    }
    // Như BackupSpec::normalize: đích local luôn ở /var/backups/itso (root 0700, ADR 0030).
    if (b.type === 'local' && (b.config.path ?? '/var/backups/itso') !== '/var/backups/itso')
      return 'Đích local luôn ở /var/backups/itso (root 0700, ADR 0030).';
    for (const k of ['endpoint', 'url'] as const) {
      if (b.config[k] && !/^https:\/\//.test(b.config[k])) return `"${k}" phải là URL https://.`;
    }
  }
  if (b.immutable_days !== undefined && b.immutable_days !== null) {
    if (!Number.isInteger(b.immutable_days) || b.immutable_days < 1)
      return 'Số ngày bất biến tối thiểu là 1.';
    if (b.type && b.type !== 's3') return 'Khóa bất biến (Object Lock) chỉ có với đích S3.';
  }
  return null;
}

/** Snapshot còn trong thời gian bất biến của đích (Object Lock): không xóa được. */
export function lockedUntil(db: DemoDb, s: Snapshot): string | null {
  const d = db.data.backup_dests.find((x) => x.uuid === s.destination.uuid);
  if (!d?.immutable_days) return null;
  const until = Date.parse(s.taken_at) + d.immutable_days * 86_400_000;
  return until > Date.now() ? new Date(until).toISOString() : null;
}

function snapshotOf(ctx: Ctx): Snapshot | Reply {
  const v = visibility(ctx.db, ctx.actor);
  const s = ctx.db.data.snapshots.find((x) => x.uuid === ctx.params.id);
  return s && (v.all || canSeeAccount(v, s.hosting_account?.uuid)) ? s : notFound('snapshot');
}

/** Nội dung snapshot dạng cây file: sites/<domain>/…, databases/<db>.sql.zst, config/. */
function snapshotTree(db: DemoDb, s: Snapshot): S['FileEntry'][] {
  const acc = db.data.accounts.find((a) => a.uuid === s.hosting_account?.uuid);
  const owner = acc?.username ?? 'root';
  const at = s.taken_at;
  const dir = (path: string): S['FileEntry'] => ({
    name: path.split('/').at(-1) as string,
    path,
    type: 'dir',
    size: 4096,
    mode: '0750',
    owner,
    modified_at: at,
  });
  const file = (path: string, size: number): S['FileEntry'] => ({
    ...dir(path),
    type: 'file',
    size,
    mode: '0640',
  });
  const out: S['FileEntry'][] = [];
  if (s.contents.includes('files')) {
    out.push(dir('sites'));
    for (const w of db.data.websites.filter((x) => x.hosting_account.uuid === acc?.uuid)) {
      const base = `sites/${w.primary_domain}`;
      out.push(dir(base), dir(`${base}/public`), file(`${base}/public/index.php`, 1734));
      out.push(file(`${base}/.env`, 412));
    }
  }
  if (s.contents.includes('databases')) {
    out.push(dir('databases'));
    for (const d of db.data.databases.filter((x) => x.hosting_account.uuid === acc?.uuid)) {
      out.push(file(`databases/${d.name}.sql.zst`, Math.round(d.size_mb * 1024 * 180)));
    }
  }
  if (s.contents.includes('config')) out.push(dir('config'), file('config/account.json', 2210));
  return out;
}

const RESTORE_ITEM = /^(files:.+|database:[a-z][a-z0-9_]{0,63}|config)$/;

/** Panel tự xóa snapshot theo retention chỉ khi mọi đích của chính sách cho phép forget (D-83). */
function retentionMode(db: DemoDb, destIds: string[]): Policy['retention_mode'] {
  return destIds.some((id) => db.data.backup_dests.find((d) => d.uuid === id)?.prune === 'cli')
    ? 'cli'
    : 'panel';
}

/** Dấu thời gian dạng 20261121-1530 cho tên thư mục/DB khôi phục. */
const stamp = (iso: string) => iso.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

/** Kết quả khôi phục (D-85): bản mới vào backups/restore-<ts>/, DB mới <tên>_r<ts>; ghi đè có snapshot trước. */
function restoreResult(
  db: DemoDb,
  r: S['Restore'],
  s: Snapshot,
): NonNullable<S['Restore']['result']> {
  const ts = stamp(db.now());
  const files = r.items.filter((i) => i.startsWith('files:')).map((i) => i.slice(6));
  const dbs = r.items.filter((i) => i.startsWith('database:')).map((i) => i.slice(9));
  if (r.mode === 'new')
    return {
      restored_paths: files.map((f) => `backups/restore-${ts}/${f}`),
      databases: dbs.map((d) => `${d}_r${ts.slice(0, 8)}`.slice(0, 64)),
      pre_restore_snapshot_uuid: null,
    };
  const pre = db.newUuid();
  db.data.snapshots.unshift({
    ...s,
    uuid: pre,
    restic_snapshot_id: (0x7d000000 + db.data.snapshots.length * 7919).toString(16),
    taken_at: db.now(),
    verified_at: null,
    tags: ['pre-restore'],
    locked_until: null,
  });
  return { restored_paths: files, databases: dbs, pre_restore_snapshot_uuid: pre };
}

/** Tổng quan Backup Center: 3-2-1-1-0 từ dữ kiện thật, job đang chạy, cảnh báo quota (D-86, D-87). */
export function backupOverview(db: DemoDb): S['BackupOverview'] {
  const dests = db.data.backup_dests;
  const healthy = dests.filter((d) => d.last_check_ok !== false);
  const imm = (d: Dest) => d.append_only || (d.immutable_days ?? 0) > 0;
  const media = new Set(healthy.map((d) => (d.type === 'rest' ? 'sftp' : d.type)));
  const offsite = healthy.filter((d) => d.type !== 'local').length;
  const immutable = healthy.filter(imm).length;
  const failing = [
    ...dests.filter((d) => d.last_check_ok === false).map((d) => `${d.name} kiểm tra lỗi`),
    ...db.data.backup_policies
      .filter((p) => p.enabled && p.last_status === 'failed')
      .map((p) => `${p.name} thất bại`),
  ];
  const latest = new Map<string, Snapshot>();
  for (const sn of db.data.snapshots) {
    if (!sn.hosting_account || sn.tags.includes('final')) continue;
    const cur = latest.get(sn.hosting_account.uuid);
    if (!cur || sn.taken_at > cur.taken_at) latest.set(sn.hosting_account.uuid, sn);
  }
  const week = Date.now() - 7 * 86_400_000;
  const unverified = [...latest.values()].filter(
    (sn) => !sn.verified_at || Date.parse(sn.verified_at) < week,
  );
  if (unverified.length) failing.push(`${unverified.length} account chưa kiểm chứng trong 7 ngày`);
  const rule = (
    key: S['BackupOverview']['rules'][number]['key'],
    okv: boolean,
    value: number,
    reason: string | null,
  ) => ({
    key,
    ok: okv,
    value,
    reason: okv ? null : reason,
  });
  const copies = healthy.length + 1;
  const quota = db.data.accounts
    .filter((a) => a.lifecycle_state === 'active' || a.lifecycle_state === 'suspended')
    .flatMap((a) => {
      const q = a.usage.backup_mb;
      if (!q.limit || q.used <= q.limit) return [];
      return [
        {
          hosting_account: { uuid: a.uuid, username: a.username },
          used_mb: q.used,
          limit_mb: q.limit,
          state: q.used > q.limit * 1.2 ? ('paused' as const) : ('warn' as const),
        },
      ];
    });
  const max = (xs: (string | null)[]) =>
    xs
      .filter((x): x is string => x !== null)
      .sort()
      .at(-1) ?? null;
  const day = Date.now() - 86_400_000;
  return {
    rules: [
      rule('copies', copies >= 3, copies, 'Cần ít nhất 2 đích khỏe ngoài bản gốc trên máy chủ.'),
      rule('media', media.size >= 2, media.size, 'Thêm đích khác loại (S3/SFTP) ngoài ổ local.'),
      rule('offsite', offsite >= 1, offsite, 'Chưa có đích ngoài máy chủ (S3, SFTP, rest-server).'),
      rule(
        'immutable',
        immutable >= 1,
        immutable,
        'Chưa có đích bất biến (Object Lock hoặc append-only).',
      ),
      rule('errors', failing.length === 0, failing.length, failing.join('; ')),
    ],
    last_backup_at: max(db.data.snapshots.map((x) => x.taken_at)),
    last_verified_at: max(
      db.data.backup_verifications.filter((v) => v.state === 'succeeded').map((v) => v.finished_at),
    ),
    failed_24h:
      db.data.backup_verifications.filter(
        (v) => v.state === 'failed' && Date.parse(v.started_at) > day,
      ).length +
      db.data.restores.filter((r) => r.state === 'failed' && Date.parse(r.created_at) > day).length,
    destinations: dests.map((d) => ({
      uuid: d.uuid,
      name: d.name,
      type: d.type,
      used_mb: d.used_mb,
      immutable: imm(d),
      last_check_ok: d.last_check_ok,
    })),
    running: db.data.jobs
      .filter((j) => /^backup/.test(j.type) && (j.state === 'running' || j.state === 'queued'))
      .map((j) => ({
        job_uuid: j.uuid,
        type: j.type,
        label: j.resource?.uuid ?? j.type,
        progress: j.progress,
        started_at: j.started_at ?? j.created_at,
      })),
    quota,
  };
}

function registerBackups() {
  on('post', P('/backup-destinations'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const b = body<S['BackupDestinationInput']>(ctx);
    const err = destError(b);
    if (err) return invalid(err);
    if (ctx.db.data.backup_dests.some((d) => d.name === b.name?.trim()))
      return conflict('Đã có đích backup cùng tên.');
    const d: Dest = {
      uuid: ctx.db.newUuid(),
      name: (b.name as string).trim(),
      type: b.type as Dest['type'],
      hosting_account: null,
      append_only: b.append_only ?? false,
      immutable_days: b.immutable_days ?? null,
      // Không lưu/không trả credentials (writeOnly); backend thật mã hóa bằng khóa của panel.
      config: { ...(b.config ?? {}) },
      used_mb: 0,
      last_check_at: null,
      last_check_ok: null,
      last_check_error: null,
      detected: null,
      // SFTP: agent sinh cặp khóa riêng cho đích, chỉ trả khóa công khai để thêm vào máy đích (D-83).
      ssh_public_key:
        b.type === 'sftp'
          ? `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemo${ctx.db.newUuid().slice(9, 13)}ItsoBackup itso-backup@srv-hn-01`
          : null,
      host_key_sha256: null,
      repositories: 0,
      prune: b.append_only || b.immutable_days ? 'cli' : 'panel',
      recovery_kit_acknowledged_at: null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    };
    ctx.db.data.backup_dests.push(d);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'backup_destination.create',
      resource: { type: 'backup_destination', uuid: d.uuid },
      changes: { type: d.type, credentials: b.credentials ? '***' : null },
    });
    return created(d);
  });

  on('patch', P('/backup-destinations/{id}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const d = ctx.db.data.backup_dests.find((x) => x.uuid === ctx.params.id);
    if (!d) return notFound('đích backup');
    const pre = precondition(ctx, d.updated_at);
    if (pre) return pre;
    const b = body<S['BackupDestinationInput']>(ctx);
    if (b.type && b.type !== d.type) return invalid('Không đổi được loại đích sau khi tạo.');
    const err = destError({ ...b, type: d.type, config: b.config ?? d.config }, true);
    if (err) return invalid(err);
    // Object Lock không giảm được thời hạn (đúng như S3 compliance mode).
    if (
      d.immutable_days &&
      b.immutable_days !== undefined &&
      (b.immutable_days ?? 0) < d.immutable_days
    )
      return conflict(
        `Không giảm được thời gian bất biến dưới ${d.immutable_days} ngày.`,
        'immutable_locked',
      );
    if (d.append_only && b.append_only === false)
      return conflict(
        'Không tắt được chế độ append-only của đích đang chứa snapshot.',
        'immutable_locked',
      );
    if (b.name !== undefined) d.name = b.name.trim();
    if (b.append_only !== undefined) d.append_only = b.append_only;
    if (b.immutable_days !== undefined) d.immutable_days = b.immutable_days;
    if (b.config) d.config = { ...b.config };
    d.prune = d.append_only || d.immutable_days ? 'cli' : 'panel';
    d.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'backup_destination.update',
      resource: { type: 'backup_destination', uuid: d.uuid },
    });
    return ok(d);
  });

  on('post', P('/backup-destinations/{id}:test'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const d = ctx.db.data.backup_dests.find((x) => x.uuid === ctx.params.id);
    if (!d) return notFound('đích backup');
    return startJob(ctx, {
      type: 'backup_destination.test',
      resource: { type: 'backup_destination', uuid: d.uuid },
      ops: ['backup.check'],
      server: SERVER_HN(ctx.db),
      onDone: (db) => {
        d.last_check_at = db.now();
        d.last_check_ok = true;
        d.last_check_error = null;
        // Phát hiện thật ở lần kiểm tra (không tin cấu hình khai báo): Object Lock của bucket, user append-only.
        d.detected = {
          append_only: d.append_only || d.type === 'rest',
          object_lock_days: d.type === 's3' ? d.immutable_days : null,
        };
        if (d.type === 'sftp')
          d.host_key_sha256 ??= 'SHA256:Zk2pV7wq0YH3dJ8bT5nR1cL9mF4sA6eX2uG0iK7oP3Q';
      },
    });
  });

  // Bộ khôi phục: lần đầu (chưa xác nhận đã lưu) trả ngay; sau đó backend thật bắt step-up (D-82).
  on('post', P('/backup-destinations/{id}:recovery-kit'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const d = ctx.db.data.backup_dests.find((x) => x.uuid === ctx.params.id);
    if (!d) return notFound('đích backup');
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'backup_destination.recovery_kit_view',
      resource: { type: 'backup_destination', uuid: d.uuid },
    });
    const kit = ctx.db.data.recovery_kit;
    const base = d.config.bucket ?? d.config.host ?? d.config.url ?? d.config.path ?? '';
    return ok({
      ...kit,
      destination: { uuid: d.uuid, name: d.name, type: d.type, config: d.config },
      repositories: kit.repositories.map((r) => ({
        ...r,
        path: `${d.type}:${base}/${r.path.split('/').slice(-3).join('/')}`,
      })),
      first_view: d.recovery_kit_acknowledged_at === null,
      generated_at: ctx.db.now(),
    });
  });

  on('post', P('/backup-destinations/{id}:recovery-kit-ack'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const d = ctx.db.data.backup_dests.find((x) => x.uuid === ctx.params.id);
    if (!d) return notFound('đích backup');
    d.recovery_kit_acknowledged_at ??= ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'backup_destination.recovery_kit_ack',
      resource: { type: 'backup_destination', uuid: d.uuid },
    });
    return noContent();
  });

  on('get', P('/backups/overview'), (ctx) => ok(backupOverview(ctx.db)));

  const policyError = (db: DemoDb, b: Partial<S['BackupPolicyInput']>, partial: boolean) => {
    if ((!partial || b.name !== undefined) && (!b.name?.trim() || b.name.length > 80))
      return 'Tên chính sách từ 1 đến 80 ký tự.';
    if (!partial && !b.scope_type) return 'Chọn phạm vi.';
    if (b.scope_type && b.scope_type !== 'all_accounts' && b.scope_type !== 'panel') {
      const rows: { uuid: string }[] = {
        server: db.data.servers,
        hosting_account: db.data.accounts,
        website: db.data.websites,
        database: db.data.databases,
        compose_project: db.data.compose as { uuid: string }[],
      }[b.scope_type];
      if (!b.scope_uuid || !rows.some((r) => r.uuid === b.scope_uuid))
        return 'Chọn đối tượng cho phạm vi.';
    }
    if ((!partial || b.schedule !== undefined) && !parseCron(b.schedule ?? '').ok)
      return 'Lịch chạy phải là biểu thức cron 5 trường hợp lệ.';
    if (!partial || b.destination_uuids !== undefined) {
      const ids = b.destination_uuids ?? [];
      if (ids.length === 0) return 'Chọn ít nhất một đích.';
      if (!ids.every((id) => db.data.backup_dests.some((d) => d.uuid === id)))
        return 'Đích backup không tồn tại.';
    }
    if ((b.excludes ?? []).length > 50) return 'Tối đa 50 mẫu loại trừ.';
    for (const x of b.excludes ?? []) {
      if (!x.trim() || x.length > 200 || x.startsWith('/') || x.split('/').includes('..'))
        return `Mẫu loại trừ "${x}" phải là đường dẫn tương đối trong home, không chứa "..".`;
    }
    for (const [k, n] of Object.entries(b.retention ?? {})) {
      if (!['hourly', 'daily', 'weekly', 'monthly', 'yearly'].includes(k))
        return `Mức giữ "${k}" không hợp lệ.`;
      if (!Number.isInteger(n) || n < 0 || n > 999) return 'Số bản giữ từ 0 đến 999.';
    }
    return null;
  };

  on('post', P('/backup-policies'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const b = body<S['BackupPolicyInput']>(ctx);
    const err = policyError(ctx.db, b, false);
    if (err) return invalid(err);
    const p: Policy = {
      uuid: ctx.db.newUuid(),
      name: (b.name as string).trim(),
      scope_type: b.scope_type as Policy['scope_type'],
      scope_uuid:
        b.scope_type === 'all_accounts' || b.scope_type === 'panel' ? null : (b.scope_uuid ?? null),
      contents:
        b.scope_type === 'compose_project'
          ? ['docker_volumes']
          : (b.contents ?? ['files', 'databases', 'config']),
      volume_consistency:
        b.scope_type === 'compose_project' ? (b.volume_consistency ?? 'pause') : null,
      excludes: b.excludes ?? [],
      schedule: b.schedule as string,
      destination_uuids: b.destination_uuids as string[],
      retention: b.retention ?? { daily: 7 },
      retention_mode: 'panel',
      enabled: b.enabled ?? true,
      last_run_at: null,
      next_run_at: null,
      last_status: null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    };
    p.retention_mode = retentionMode(ctx.db, p.destination_uuids);
    ctx.db.data.backup_policies.push(p);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'backup_policy.create',
      resource: { type: 'backup_policy', uuid: p.uuid },
    });
    return created(p);
  });

  on('patch', P('/backup-policies/{id}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const p = ctx.db.data.backup_policies.find((x) => x.uuid === ctx.params.id);
    if (!p) return notFound('chính sách backup');
    const pre = precondition(ctx, p.updated_at);
    if (pre) return pre;
    const b = body<S['BackupPolicyInput']>(ctx);
    const err = policyError(
      ctx.db,
      {
        ...b,
        scope_type: b.scope_type ?? p.scope_type,
        scope_uuid: has(b, 'scope_uuid') ? (b.scope_uuid ?? null) : p.scope_uuid,
      },
      true,
    );
    if (err) return invalid(err);
    const changes: Record<string, unknown> = {};
    for (const k of [
      'name',
      'scope_type',
      'scope_uuid',
      'contents',
      'volume_consistency',
      'excludes',
      'schedule',
      'destination_uuids',
      'retention',
      'enabled',
    ] as const) {
      if (b[k] !== undefined) {
        changes[k] = [p[k], b[k]];
        Object.assign(p, { [k]: b[k] });
      }
    }
    p.retention_mode = retentionMode(ctx.db, p.destination_uuids);
    p.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'backup_policy.update',
      resource: { type: 'backup_policy', uuid: p.uuid },
      changes,
    });
    return ok(p);
  });

  on('delete', P('/backup-policies/{id}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const i = ctx.db.data.backup_policies.findIndex((x) => x.uuid === ctx.params.id);
    if (i < 0) return notFound('chính sách backup');
    const [p] = ctx.db.data.backup_policies.splice(i, 1);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'backup_policy.delete',
      resource: { type: 'backup_policy', uuid: p?.uuid ?? '' },
    });
    return noContent();
  });

  on('post', P('/backup-policies/{id}:run'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const p = ctx.db.data.backup_policies.find((x) => x.uuid === ctx.params.id);
    if (!p) return notFound('chính sách backup');
    if (p.last_status === 'running') return conflict('Chính sách đang chạy.');
    p.last_status = 'running';
    return startJob(ctx, {
      type: 'backup.policy.run',
      resource: { type: 'backup_policy', uuid: p.uuid },
      ops:
        p.retention_mode === 'panel'
          ? ['backup.run', 'backup.check', 'backup.forget']
          : ['backup.run', 'backup.check'],
      server: SERVER_HN(ctx.db),
      onDone: (db) => {
        p.last_run_at = db.now();
        p.last_status = 'succeeded';
      },
    });
  });

  on('delete', P('/backup-snapshots/{id}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const s = snapshotOf(ctx);
    if (isReply(s)) return s;
    const until = lockedUntil(ctx.db, s);
    const dest = ctx.db.data.backup_dests.find((x) => x.uuid === s.destination.uuid);
    if (!until && dest?.append_only)
      return conflict(
        'Đích append-only: panel không xóa được snapshot. Dọn bằng `itso backup prune` trên máy chủ.',
        'immutable_locked',
      );
    if (until)
      return conflict(
        `Snapshot nằm trên đích bất biến, chỉ xóa được sau ${until.slice(0, 10)}.`,
        'immutable_locked',
      );
    if (s.tags.includes('pre-purge'))
      return conflict(
        'Snapshot cuối trước khi purge được giữ theo chính sách, không xóa tay.',
        'immutable_locked',
      );
    return startJob(ctx, {
      type: 'backup.snapshot.delete',
      resource: { type: 'backup_snapshot', uuid: s.uuid },
      ops: ['backup.forget'],
      server: SERVER_HN(ctx.db),
      onDone: (db) => {
        db.data.snapshots = db.data.snapshots.filter((x) => x.uuid !== s.uuid);
      },
    });
  });

  on('post', P('/backup-snapshots/{id}:verify'), (ctx) => {
    const s = snapshotOf(ctx);
    if (isReply(s)) return s;
    return startJob(ctx, {
      type: 'backup.snapshot.verify',
      resource: { type: 'backup_snapshot', uuid: s.uuid },
      ops: ['backup.check', 'backup.restore_test'],
      server: SERVER_HN(ctx.db),
      onDone: (db) => {
        s.verified_at = db.now();
        db.data.backup_verifications.unshift({
          uuid: db.newUuid(),
          kind: 'restore_test',
          destination: s.destination,
          hosting_account: s.hosting_account,
          snapshot_uuid: s.uuid,
          state: 'succeeded',
          read_data_percent: null,
          files_checked: 1200 + Math.round(s.size_mb),
          mismatches: 0,
          error: null,
          started_at: db.now(),
          finished_at: db.now(),
        });
      },
    });
  });
}

/**
 * Backup thủ công, duyệt snapshot, link tải và khôi phục: Admin (trong phạm vi) và Portal (account
 * của chính mình) dùng chung handler.
 */
export function registerBackupAccess(realm: 'admin' | 'portal') {
  const R = (p: string) => `/api/v1/${realm}${p}` as Parameters<typeof on>[1];
  // Backup thủ công một account (ADMIN trong phạm vi được phép).
  on('post', R('/backups'), (ctx) => {
    const b = body<S['BackupRequest']>(ctx);
    const v = visibility(ctx.db, ctx.actor);
    const a = ctx.db.data.accounts.find((x) => x.uuid === b.hosting_account_uuid);
    if (!a || !canSeeAccount(v, a.uuid))
      return invalid('Chọn tài khoản hosting trong phạm vi của bạn.');
    if (a.lifecycle_state === 'terminated' || a.lifecycle_state === 'provisioning')
      return conflict('Tài khoản không ở trạng thái backup được.', 'invalid_state_transition');
    const contents = b.contents ?? [];
    if (
      contents.length === 0 ||
      !contents.every((c) => ['files', 'databases', 'config'].includes(c))
    )
      return invalid('Chọn ít nhất một nội dung: files, databases, config.');
    if (b.note && b.note.length > 200) return invalid('Ghi chú tối đa 200 ký tự.');
    const bq = a.usage.backup_mb;
    if (bq.limit > 0 && bq.used > bq.limit * 1.2)
      return conflict(
        `Dung lượng backup ${Math.round(bq.used / 1024)} GB vượt 120 % quota (${Math.round(bq.limit / 1024)} GB): backup tạm dừng. Xóa bớt bản cũ hoặc nâng gói.`,
        'quota_exceeded',
      );
    const dest =
      ctx.db.data.backup_dests.find((d) => d.type === 'local') ?? ctx.db.data.backup_dests[0];
    if (!dest) return conflict('Chưa có đích backup nào.');
    return startJob(ctx, {
      type: 'backup.manual',
      resource: { type: 'hosting_account', uuid: a.uuid },
      ops: ['backup.run', 'backup.check'],
      server: a.server,
      changes: { contents, note: b.note ?? null },
      onDone: (db) => {
        const n = db.data.snapshots.length + 1;
        db.data.snapshots.unshift({
          uuid: db.newUuid(),
          hosting_account: { uuid: a.uuid, username: a.username },
          destination: { uuid: dest.uuid, name: dest.name },
          scope_type: 'hosting_account',
          repository_uuid:
            db.data.backup_repos.find(
              (r) => r.hosting_account?.uuid === a.uuid && r.destination.uuid === dest.uuid,
            )?.uuid ?? null,
          website: null,
          volumes: [],
          databases: contents.includes('databases')
            ? db.data.databases.filter((x) => x.hosting_account.uuid === a.uuid).map((x) => x.name)
            : [],
          restic_snapshot_id: (0x7c000000 + n * 7919).toString(16),
          size_mb: Math.round(a.usage.disk_mb.used * 0.8 * 10) / 10,
          taken_at: db.now(),
          verified_at: null,
          contents: contents as Snapshot['contents'],
          tags: b.note ? ['manual', b.note] : ['manual'],
          panel_version: '0.1.0-alpha',
          locked_until: null,
        });
      },
    });
  });

  on('get', R('/backup-snapshots/{id}/browse'), (ctx) => {
    const s = snapshotOf(ctx);
    if (isReply(s)) return s;
    const q = (ctx.query.get('path') ?? '.').replace(/\/+$/, '');
    const raw = q === '.' || q === '' ? '' : q.replace(/^\.\//, '');
    if (raw.split('/').includes('..') || raw.startsWith('/'))
      return invalid('Đường dẫn phải là đường dẫn tương đối, không chứa "..".');
    const all = snapshotTree(ctx.db, s);
    const depth = raw === '' ? 0 : raw.split('/').length;
    const rows = all.filter(
      (e) => (raw === '' || e.path.startsWith(`${raw}/`)) && e.path.split('/').length === depth + 1,
    );
    if (raw !== '' && !all.some((e) => e.path === raw && e.type === 'dir'))
      return notFound('thư mục trong snapshot');
    return page(ctx, rows, { sort: 'name' });
  });

  on('post', R('/backup-snapshots/{id}:download-link'), (ctx) => {
    const s = snapshotOf(ctx);
    if (isReply(s)) return s;
    const path = body<S['BackupDownloadRequest']>(ctx).path ?? null;
    if (path !== null) {
      if (path.startsWith('/') || path.split('/').includes('..'))
        return invalid('Đường dẫn phải là đường dẫn tương đối, không chứa "..".');
      if (!snapshotTree(ctx.db, s).some((e) => e.path === path))
        return notFound('file trong snapshot');
    }
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'backup.snapshot.download_link',
      resource: { type: 'backup_snapshot', uuid: s.uuid },
      ...(path ? { changes: { path } } : {}),
    });
    const exp = new Date(Date.now() + 15 * 60_000);
    const name = path
      ? encodeURIComponent(path.split('/').at(-1) ?? 'file')
      : `${s.restic_snapshot_id}.tar.zst`;
    return ok({
      url: `https://panel.itso.local/dl/backup/${s.restic_snapshot_id}/${name}?sig=demo`,
      expires_at: exp.toISOString(),
    });
  });

  on('post', R('/restores'), (ctx) => {
    const b = body<S['RestoreRequest']>(ctx);
    const v = visibility(ctx.db, ctx.actor);
    const s = ctx.db.data.snapshots.find((x) => x.uuid === b.snapshot_uuid);
    if (!s || !s.hosting_account || !canSeeAccount(v, s.hosting_account.uuid))
      return invalid('Chọn snapshot trong phạm vi của bạn.');
    const a = ctx.db.data.accounts.find((x) => x.uuid === s.hosting_account?.uuid);
    if (!a) return invalid('Account của snapshot không còn tồn tại.');
    if (b.mode !== 'new' && b.mode !== 'overwrite') return invalid('Chọn cách khôi phục.');
    const items = b.items ?? [];
    if (items.length === 0) return invalid('Chọn ít nhất một mục cần khôi phục.');
    for (const it of items) {
      if (!RESTORE_ITEM.test(it)) return invalid(`Mục "${it}" không hợp lệ.`);
      const [kind, ref = ''] = it.split(/:(.*)/s);
      if (kind === 'files') {
        if (!s.contents.includes('files')) return invalid('Snapshot không chứa file.');
        if (ref.split('/').includes('..') || ref.startsWith('/'))
          return invalid('Đường dẫn file phải nằm trong home của account.');
      }
      if (kind === 'database') {
        if (!s.contents.includes('databases')) return invalid('Snapshot không chứa database.');
        if (!ctx.db.data.databases.some((d) => d.name === ref && d.hosting_account.uuid === a.uuid))
          return invalid(`Snapshot không có database "${ref}".`);
      }
      if (kind === 'config' && !s.contents.includes('config'))
        return invalid('Snapshot không chứa cấu hình.');
    }
    // Khôi phục sang server khác (D-93, chỉ Admin, chỉ ra bản mới): đích phải trực tuyến; account được
    // tạo ở đích nếu chưa có (account.ensure) rồi restic restore từ cùng repo.
    let target = a.server;
    if (b.target_server_uuid && b.target_server_uuid !== a.server.uuid) {
      if (realm !== 'admin') return invalid('Portal chỉ khôi phục trên server hiện tại.');
      if (b.mode !== 'new') return invalid('Sang server khác: chỉ khôi phục ra bản mới.');
      const srv = ctx.db.data.servers.find((x) => x.uuid === b.target_server_uuid);
      if (!srv || !canSeeServer(v, srv.uuid)) return invalid('Chọn server đích trong phạm vi.');
      if (srv.connection !== 'online' || srv.status !== 'ready')
        return conflict(`Server ${srv.name} không kết nối; chọn server khác.`, 'agent_unreachable');
      target = { uuid: srv.uuid, name: srv.name };
    }
    if (a.lifecycle_state !== 'active')
      return conflict(
        `Account đang ${a.lifecycle_state}: kích hoạt lại trước khi khôi phục.`,
        'invalid_state_transition',
      );
    if (items.includes('config'))
      return invalid('Khôi phục cấu hình máy chủ: dùng DR ("itso backup panel-restore").');
    if (b.mode === 'overwrite') {
      if (items.length !== 1 || !/^(files:sites\/[a-z0-9.-]+|database:.+)$/.test(items[0] ?? ''))
        return invalid('Ghi đè: mỗi lần đúng một website hoặc một database.');
      if (b.confirm !== a.username)
        return fieldInvalid('confirm', 'Gõ đúng username account để xác nhận ghi đè.');
    }
    const r: S['Restore'] = {
      uuid: ctx.db.newUuid(),
      snapshot_uuid: s.uuid,
      hosting_account: { uuid: a.uuid, username: a.username },
      target_server: target,
      mode: b.mode,
      items,
      state: 'queued',
      job_uuid: null,
      requested_by: actorRef(ctx),
      created_at: ctx.db.now(),
      finished_at: null,
      result: null,
      error: null,
    };
    ctx.db.data.restores.unshift(r);
    const reply = startJob(ctx, {
      type: 'backup.restore',
      resource: { type: 'restore', uuid: r.uuid },
      ops:
        target.uuid === a.server.uuid ? ['backup.restore'] : ['account.ensure', 'backup.restore'],
      server: target,
      changes: { snapshot: s.restic_snapshot_id, mode: b.mode, items, target: target.name },
      onDone: (db) => {
        r.state = 'succeeded';
        r.finished_at = db.now();
        r.result = restoreResult(db, r, s);
      },
    });
    r.job_uuid = (reply.body as { job: { uuid: string } }).job.uuid;
    r.state = 'running';
    return reply;
  });
}

// ---------------------------------------------------------------- người dùng
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_OF_REALM: Record<User['realm'], User['role'][]> = {
  admin: ['SUPER_ADMIN', 'ADMIN'],
  portal: ['USER'],
};

/** ADMIN chỉ thao tác được trên USER portal sở hữu account trong phạm vi; SA thao tác mọi người trừ chính mình. */
function userFor(ctx: Ctx, { self = false }: { self?: boolean } = {}): User | Reply {
  const u = ctx.db.data.users.find((x) => x.uuid === ctx.params.id);
  if (!u) return notFound('người dùng');
  if (!self && u.uuid === ctx.actor.uuid)
    return problem(403, 'forbidden', 'Không tự thực hiện thao tác này trên tài khoản của mình');
  if (ctx.actor.role === 'SUPER_ADMIN') return u;
  if (u.realm !== 'portal')
    return problem(403, 'forbidden', 'Chỉ Super Admin quản lý tài khoản quản trị');
  const v = visibility(ctx.db, ctx.actor);
  const mine = ctx.db.data.accounts.some(
    (a) => a.owner.uuid === u.uuid && canSeeAccount(v, a.uuid),
  );
  return mine ? u : problem(403, 'forbidden', 'Người dùng không thuộc phạm vi của bạn');
}

function registerUsers() {
  on('post', P('/users'), (ctx) => {
    const b = body<S['UserCreate']>(ctx);
    if (b.realm !== 'admin' && b.realm !== 'portal') return invalid('Chọn loại tài khoản.');
    if (b.realm === 'admin') {
      const deny = saOnly(ctx);
      if (deny) return deny;
    }
    if (!b.name?.trim() || b.name.length > 120) return invalid('Tên từ 1 đến 120 ký tự.');
    if (!b.email || !EMAIL.test(b.email)) return invalid('Email không hợp lệ.');
    if (!b.role || !ROLE_OF_REALM[b.realm].includes(b.role))
      return invalid('Vai trò phải khớp loại tài khoản.');
    const email = b.email.trim().toLowerCase();
    if (ctx.db.data.users.some((u) => u.email.toLowerCase() === email))
      return conflict('Email đã được dùng cho người dùng khác.');
    const u: User = {
      uuid: ctx.db.newUuid(),
      realm: b.realm,
      name: b.name.trim(),
      email,
      role: b.role,
      status: 'active',
      mfa_enabled: false,
      locale: b.locale ?? 'vi',
      timezone: 'Asia/Ho_Chi_Minh',
      last_login_at: null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    };
    ctx.db.data.users.push(u);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'user.create',
      resource: { type: 'user', uuid: u.uuid },
      changes: { role: u.role, send_invite: b.send_invite ?? true },
    });
    return created(u);
  });

  on('patch', P('/users/{id}'), (ctx) => {
    const u = userFor(ctx, { self: true });
    if (isReply(u)) return u;
    const pre = precondition(ctx, u.updated_at);
    if (pre) return pre;
    const b = body<S['UserUpdate']>(ctx);
    if (b.role !== undefined) {
      if (u.uuid === ctx.actor.uuid)
        return problem(403, 'forbidden', 'Không tự đổi vai trò của mình');
      if (ctx.actor.role !== 'SUPER_ADMIN')
        return problem(403, 'forbidden', 'Chỉ Super Admin đổi vai trò');
      if (!ROLE_OF_REALM[u.realm].includes(b.role))
        return invalid('Vai trò phải khớp loại tài khoản.');
      if (u.role === 'SUPER_ADMIN' && b.role !== 'SUPER_ADMIN') {
        const left = ctx.db.data.users.filter(
          (x) => x.role === 'SUPER_ADMIN' && x.status === 'active',
        );
        if (left.length <= 1) return conflict('Phải còn ít nhất một Super Admin hoạt động.');
      }
    }
    if (b.name !== undefined && (!b.name.trim() || b.name.length > 120))
      return invalid('Tên từ 1 đến 120 ký tự.');
    if (b.email !== undefined) {
      if (!EMAIL.test(b.email)) return invalid('Email không hợp lệ.');
      const e = b.email.toLowerCase();
      if (ctx.db.data.users.some((x) => x.uuid !== u.uuid && x.email.toLowerCase() === e))
        return conflict('Email đã được dùng cho người dùng khác.');
    }
    const changes: Record<string, unknown> = {};
    for (const k of ['name', 'email', 'locale', 'role'] as const) {
      if (b[k] !== undefined && b[k] !== u[k]) {
        changes[k] = [u[k], b[k]];
        Object.assign(u, { [k]: k === 'email' ? (b[k] as string).toLowerCase() : b[k] });
      }
    }
    u.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'user.update',
      resource: { type: 'user', uuid: u.uuid },
      changes,
    });
    return ok(u);
  });

  on('put', P('/users/{id}/scopes'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const u = ctx.db.data.users.find((x) => x.uuid === ctx.params.id);
    if (!u) return notFound('người dùng');
    if (u.role !== 'ADMIN') return invalid('Chỉ giao phạm vi cho vai trò ADMIN.');
    const b = body<S['UserScopesPut']>(ctx);
    if (!Array.isArray(b.scopes)) return invalid('Thiếu danh sách phạm vi.');
    const rows: S['UserScope'][] = [];
    for (const sc of b.scopes) {
      const src =
        sc.scope_type === 'server'
          ? ctx.db.data.servers.find((x) => x.uuid === sc.uuid)
          : sc.scope_type === 'hosting_account'
            ? ctx.db.data.accounts.find((x) => x.uuid === sc.uuid)
            : undefined;
      if (!src) return invalid('Phạm vi chỉ gồm server hoặc tài khoản hosting có thật.');
      if (rows.some((r) => r.uuid === sc.uuid)) continue;
      rows.push({
        scope_type: sc.scope_type,
        uuid: sc.uuid,
        name: 'username' in src ? src.username : src.name,
      });
    }
    const before = scopeRows(ctx.db, u.uuid).map((r) => r.name);
    ctx.db.data[`scopes@${u.uuid}`] = rows;
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'user.scopes.update',
      resource: { type: 'user', uuid: u.uuid },
      changes: { scopes: [before, rows.map((r) => r.name)] },
    });
    return page(ctx, rows);
  });

  const toggle = (
    action: 'lock' | 'unlock' | 'reset-mfa',
    check: (u: User) => string | null,
    apply: (u: User) => void,
  ) =>
    on('post', P(`/users/{id}:${action}`), (ctx) => {
      const u = userFor(ctx);
      if (isReply(u)) return u;
      const err = check(u);
      if (err) return conflict(err);
      apply(u);
      u.updated_at = ctx.db.now();
      ctx.db.audit({
        actor: actorRef(ctx),
        action: `user.${action.replace('-', '_')}`,
        resource: { type: 'user', uuid: u.uuid },
      });
      return ok(u);
    });
  toggle(
    'lock',
    (u) => (u.status === 'locked' ? 'Người dùng đã bị khóa.' : null),
    (u) => {
      u.status = 'locked';
    },
  );
  toggle(
    'unlock',
    (u) => (u.status !== 'locked' ? 'Người dùng không bị khóa.' : null),
    (u) => {
      u.status = 'active';
    },
  );
  toggle(
    'reset-mfa',
    (u) => (!u.mfa_enabled ? 'Người dùng chưa bật MFA.' : null),
    (u) => {
      u.mfa_enabled = false;
    },
  );

  on('post', P('/users/{id}:impersonate'), (ctx) => {
    const u = userFor(ctx);
    if (isReply(u)) return u;
    if (u.realm !== 'portal') return invalid('Chỉ đăng nhập thay được người dùng portal.');
    if (u.status !== 'active')
      return conflict('Người dùng đang bị khóa.', 'invalid_state_transition');
    const reason = body<S['ReasonRequest']>(ctx).reason?.trim() ?? '';
    if (reason.length < 5 || reason.length > 500) return invalid('Lý do từ 5 đến 500 ký tự.');
    const now = Date.now();
    const imp: S['Impersonation'] = {
      uuid: ctx.db.newUuid(),
      staff: actorRef(ctx),
      target: { uuid: u.uuid, name: u.name, email: u.email },
      reason,
      started_at: ctx.db.now(),
      expires_at: new Date(now + 30 * 60_000).toISOString(),
      portal_url: `https://portal.itso.local/impersonate/${u.uuid}`,
    };
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'impersonation.start',
      resource: { type: 'user', uuid: u.uuid },
      changes: { reason },
    });
    return created(imp);
  });
}

// ---------------------------------------------------------------- giám sát, audit, thông báo, cài đặt
const METRICS = [
  'cpu_pct',
  'ram_pct',
  'disk_pct',
  'load_1m',
  'quota_disk_pct',
  'http_latency_ms',
  'http_status',
];

function ruleError(b: Partial<S['AlertRuleInput']>, partial: boolean): string | null {
  if ((!partial || b.name !== undefined) && (!b.name?.trim() || b.name.length > 120))
    return 'Tên luật từ 1 đến 120 ký tự.';
  if ((!partial || b.metric !== undefined) && !METRICS.includes(b.metric ?? ''))
    return 'Chọn chỉ số.';
  if (
    (!partial || b.scope_type !== undefined) &&
    !['server', 'hosting_account', 'website'].includes(b.scope_type ?? '')
  )
    return 'Chọn phạm vi.';
  if (
    (!partial || b.operator !== undefined) &&
    !['gt', 'lt', 'gte', 'lte'].includes(b.operator ?? '')
  )
    return 'Chọn phép so sánh.';
  if (
    (!partial || b.threshold !== undefined) &&
    (typeof b.threshold !== 'number' || !Number.isFinite(b.threshold))
  )
    return 'Ngưỡng phải là số.';
  if (
    (b.metric ?? '').endsWith('_pct') &&
    typeof b.threshold === 'number' &&
    (b.threshold < 0 || b.threshold > 100)
  )
    return 'Ngưỡng phần trăm từ 0 đến 100.';
  if (
    b.for_sec !== undefined &&
    (!Number.isInteger(b.for_sec) || b.for_sec < 0 || b.for_sec > 86400)
  )
    return 'Thời gian duy trì từ 0 đến 86400 giây.';
  if (
    (!partial || b.severity !== undefined) &&
    !['low', 'medium', 'high', 'critical'].includes(b.severity ?? '')
  )
    return 'Chọn mức độ.';
  if (b.channels && !b.channels.every((c) => ['email', 'telegram', 'in_app'].includes(c)))
    return 'Kênh thông báo không hợp lệ.';
  return null;
}

/** Tên hiển thị của tài nguyên trong audit (username, domain, tên server…). */
export function resourceLabel(db: DemoDb, r: { type: string; uuid: string } | null): string {
  if (!r) return '';
  const find = <T extends { uuid: string }>(rows: T[]) => rows.find((x) => x.uuid === r.uuid);
  const label =
    find(db.data.accounts)?.username ??
    find(db.data.websites)?.primary_domain ??
    find(db.data.servers)?.name ??
    find(db.data.databases)?.name ??
    find(db.data.users)?.email ??
    (find(db.data.packages) as { name?: string } | undefined)?.name ??
    (find(db.data.backup_policies) as { name?: string } | undefined)?.name;
  return label ?? `${r.type}:${r.uuid.slice(-6)}`;
}

function registerOps() {
  on('post', P('/alert-rules'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const b = body<S['AlertRuleInput']>(ctx);
    const err = ruleError(b, false);
    if (err) return invalid(err);
    const rules = ctx.db.data.alert_rules as Rule[];
    if (rules.some((r) => r.name === b.name?.trim())) return conflict('Đã có luật cùng tên.');
    const r: Rule = {
      uuid: ctx.db.newUuid(),
      name: (b.name as string).trim(),
      metric: b.metric as string,
      scope_type: b.scope_type as Rule['scope_type'],
      scope_uuid: b.scope_uuid ?? null,
      operator: b.operator as Rule['operator'],
      threshold: b.threshold as number,
      for_sec: b.for_sec ?? 0,
      severity: b.severity as Rule['severity'],
      channels: b.channels ?? ['in_app'],
      enabled: b.enabled ?? true,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    };
    rules.push(r);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'alert_rule.create',
      resource: { type: 'alert_rule', uuid: r.uuid },
    });
    return created(r);
  });

  on('patch', P('/alert-rules/{id}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const r = (ctx.db.data.alert_rules as Rule[]).find((x) => x.uuid === ctx.params.id);
    if (!r) return notFound('luật cảnh báo');
    const pre = precondition(ctx, r.updated_at);
    if (pre) return pre;
    const b = body<S['AlertRuleInput']>(ctx);
    const err = ruleError({ ...b, metric: b.metric ?? r.metric }, true);
    if (err) return invalid(err);
    const changes: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(b)) {
      if (val !== undefined && k in r) {
        changes[k] = [r[k as keyof Rule], val];
        Object.assign(r, { [k]: val });
      }
    }
    r.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'alert_rule.update',
      resource: { type: 'alert_rule', uuid: r.uuid },
      changes,
    });
    return ok(r);
  });

  on('delete', P('/alert-rules/{id}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const rules = ctx.db.data.alert_rules as Rule[];
    const i = rules.findIndex((x) => x.uuid === ctx.params.id);
    if (i < 0) return notFound('luật cảnh báo');
    const alerts = ctx.db.data.alerts as S['Alert'][];
    if (alerts.some((a) => a.rule.uuid === ctx.params.id && a.state === 'firing'))
      return conflict('Luật đang có cảnh báo chưa xử lý; tắt luật hoặc chờ cảnh báo kết thúc.');
    rules.splice(i, 1);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'alert_rule.delete',
      resource: { type: 'alert_rule', uuid: ctx.params.id ?? '' },
    });
    return noContent();
  });

  on('get', P('/audit-logs/export'), (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const action = ctx.query.get('filter[action]');
    const actor = ctx.query.get('filter[actor]');
    const rows = ctx.db.data.audit
      .filter((e) => v.all || e.actor?.uuid === ctx.actor.uuid)
      .filter((e) => !action || e.action === action)
      .filter((e) => !actor || e.actor?.uuid === actor)
      .sort((a, b) => b.at.localeCompare(a.at));
    const csv = toCsv(
      [
        'at',
        'actor',
        'impersonator',
        'actor_ip',
        'action',
        'resource',
        'server',
        'result',
        'job_uuid',
        'hash',
      ],
      rows.map((e) => [
        e.at,
        e.actor?.email ?? '',
        e.impersonator?.email ?? '',
        e.actor_ip,
        e.action,
        resourceLabel(ctx.db, e.resource),
        (pick(e as never, 'server.name') as string | undefined) ?? '',
        e.result,
        e.job_uuid,
        e.hash,
      ]),
    );
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'audit_log.export',
      resource: null,
      changes: { rows: rows.length },
    });
    return {
      status: 200,
      body: csv,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="audit-logs.csv"',
      },
    };
  });

  on('post', P('/notifications/{id}:read'), (ctx) => {
    const n = ctx.db.data.notifications.find((x) => x.uuid === ctx.params.id);
    if (!n) return notFound('thông báo');
    n.read_at ??= ctx.db.now();
    return noContent();
  });
  on('post', P('/notifications:read-all'), (ctx) => {
    for (const n of ctx.db.data.notifications) n.read_at ??= ctx.db.now();
    return noContent();
  });

  on('patch', P('/notification-preferences'), (ctx) => {
    const cur = ctx.db.data.notification_prefs as S['NotificationPreferences'];
    const pre = precondition(ctx, cur.updated_at);
    if (pre) return pre;
    const b = body<S['NotificationPreferences']>(ctx);
    const CH = ['email', 'telegram', 'in_app'];
    if (b.channels && !Object.keys(b.channels).every((k) => CH.includes(k)))
      return invalid('Kênh thông báo không hợp lệ.');
    for (const list of Object.values(b.events ?? {})) {
      if (!list.every((c) => CH.includes(c))) return invalid('Kênh thông báo không hợp lệ.');
    }
    if (b.channels) cur.channels = { ...cur.channels, ...b.channels };
    if (b.events) cur.events = { ...b.events };
    cur.updated_at = ctx.db.now();
    return ok(cur);
  });

  on('patch', P('/settings/{group}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const all = ctx.db.data.settings as Record<string, Record<string, unknown>>;
    const g = all[ctx.params.group ?? ''];
    if (!g) return notFound('nhóm cài đặt');
    const b = body<Record<string, unknown>>(ctx);
    const err = settingsError(ctx.params.group ?? '', { ...g, ...b });
    if (err) return invalid(err);
    const unknown = Object.keys(b).filter((k) => !(k in g));
    if (unknown.length) return invalid(`Không có cài đặt: ${unknown.join(', ')}.`);
    const changes: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(b)) {
      // Mật khẩu SMTP: chỉ ghi, không đưa giá trị vào audit.
      changes[k] = k.includes('password') ? '***' : [g[k], val];
      g[k] = val;
    }
    ctx.db.audit({
      actor: actorRef(ctx),
      action: `settings.${ctx.params.group}.update`,
      resource: null,
      changes,
    });
    return ok({ group: ctx.params.group, values: g });
  });

  on('get', P('/system/version'), () =>
    ok({
      version: '0.2.0-demo',
      commit: 'phase-2',
      agent_min_version: '0.1.0',
      update_available: null,
    }),
  );

  on('post', P('/api-tokens'), (ctx) => {
    const b = body<S['ApiTokenCreate']>(ctx);
    if (!b.name?.trim() || b.name.length > 80) return invalid('Tên token từ 1 đến 80 ký tự.');
    if (!b.scopes?.length || !b.scopes.every((s) => /^[a-z_]+:(read|write)$/.test(s)))
      return invalid('Chọn ít nhất một quyền dạng "tài_nguyên:read|write".');
    const exp = Date.parse(b.expires_at ?? '');
    if (!Number.isFinite(exp) || exp <= Date.now())
      return invalid('Ngày hết hạn phải ở tương lai.');
    if (exp > Date.now() + 366 * 86_400_000) return invalid('Token có hạn tối đa 1 năm.');
    const tokens = ctx.db.data.api_tokens as S['ApiToken'][];
    const t: S['ApiToken'] = {
      uuid: ctx.db.newUuid(),
      name: b.name.trim(),
      scopes: b.scopes,
      last_used_at: null,
      expires_at: new Date(exp).toISOString(),
      created_at: ctx.db.now(),
    };
    tokens.push(t);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'api_token.create',
      resource: { type: 'api_token', uuid: t.uuid },
      changes: { scopes: t.scopes },
    });
    return created({ secret: `itso_pat_demo${t.uuid.slice(-8)}` });
  });

  on('delete', P('/api-tokens/{id}'), (ctx) => {
    const tokens = ctx.db.data.api_tokens as S['ApiToken'][];
    const i = tokens.findIndex((x) => x.uuid === ctx.params.id);
    if (i < 0) return notFound('API token');
    tokens.splice(i, 1);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'api_token.revoke',
      resource: { type: 'api_token', uuid: ctx.params.id ?? '' },
    });
    return noContent();
  });
}

/** Kiểm cài đặt theo nhóm (form ở trang Cài đặt dùng cùng quy tắc). */
export function settingsError(group: string, v: Record<string, unknown>): string | null {
  if (group === 'general') {
    if (typeof v.panel_name !== 'string' || !v.panel_name.trim() || v.panel_name.length > 60)
      return 'Tên panel từ 1 đến 60 ký tự.';
    if (!['vi', 'en'].includes(v.default_locale as string))
      return 'Ngôn ngữ mặc định không hợp lệ.';
  }
  if (group === 'security') {
    const n = v.session_lifetime_min as number;
    if (!Number.isInteger(n) || n < 15 || n > 720) return 'Thời gian phiên từ 15 đến 720 phút.';
    const c = v.portal_captcha_after_failures as number;
    if (!Number.isInteger(c) || c < 0 || c > 10) return 'Captcha sau 0 (luôn bật) đến 10 lần sai.';
    if (v.admin_mfa_required !== true) return 'MFA cho quản trị viên là bắt buộc, không tắt được.';
  }
  if (group === 'smtp') {
    const p = v.port as number;
    if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Cổng SMTP từ 1 đến 65535.';
    if (!['none', 'starttls', 'tls'].includes(v.encryption as string))
      return 'Kiểu mã hóa không hợp lệ.';
    if (typeof v.host !== 'string' || !v.host.trim()) return 'Nhập máy chủ SMTP.';
  }
  return null;
}

export function registerGovernance() {
  registerBackupAccess('admin');
  registerSecurity();
  registerBackups();
  registerUsers();
  registerOps();
}
