import type { components as C } from '@/api/generated/portal/schema';
import type { DemoDb } from '../db';
import { findOr404, isReply, page } from '../list';
import { created, noContent, ok, on, problem, type ApiPath, type Ctx } from '../router';
import { canSeeAccount, visibility } from '../scope';
import { ADMIN_LISTS, accountOr404, logsOf, registerListSpecs, type ListSpec } from './admin';
import { registerBackupAccess } from './governance';
import { registerSites } from './sites';
import { actorRef, jobActions } from './writes';

/**
 * Prompt 2.7: User Hosting Portal. Mọi handler lọc theo account mà USER đang đăng nhập sở hữu
 * (`visibility` của USER = account có owner là mình); ngoài phạm vi → 404, không lộ sự tồn tại.
 */
type S = C['schemas'];
type Job = DemoDb['data']['jobs'][number];
type Note = S['Notification'];
type Prefs = S['NotificationPreferences'];

const P = (p: string) => `/api/v1/portal${p}` as ApiPath;
const invalid = (detail: string) =>
  problem(422, 'validation_failed', 'Dữ liệu không hợp lệ', detail);

/** Tài nguyên Portal có danh sách: dùng lại bảng của Admin, đổi tiền tố đường dẫn. */
const PORTAL_RESOURCES = new Set([
  'hosting-accounts',
  'websites',
  'databases',
  'database-users',
  'sftp-accounts',
  'ssh-keys',
  'cron-jobs',
  'certificates',
  'backup-snapshots',
  'restores',
  'wordpress/sites',
  'git-repositories',
]);
const toPortal = (p: string) => p.replace('/api/v1/admin/', '/api/v1/portal/') as ApiPath;
export const PORTAL_LISTS: ListSpec[] = ADMIN_LISTS.filter((s) =>
  PORTAL_RESOURCES.has(s.path.replace('/api/v1/admin/', '')),
).map((s) => ({
  ...s,
  path: toPortal(s.path),
  ...(s.detail ? { detail: toPortal(s.detail) } : {}),
}));

/** Account sở hữu tài nguyên mà job tác động (để Portal chỉ thấy job của mình). */
export function jobAccount(db: DemoDb, j: Job): string | null {
  const r = j.resource;
  if (!r) return null;
  if (r.type === 'hosting_account') return r.uuid;
  const colls = [
    'websites',
    'databases',
    'db_users',
    'sftp',
    'ssh_keys',
    'cron',
    'certs',
    'snapshots',
    'restores',
    'wordpress',
    'git_repositories',
  ] as const;
  for (const k of colls) {
    const rows = db.data[k] as unknown as {
      uuid: string;
      hosting_account?: { uuid: string } | null;
      website?: { uuid: string } | null;
    }[];
    const row = rows.find((x) => x.uuid === r.uuid);
    if (!row) continue;
    if (row.hosting_account) return row.hosting_account.uuid;
    const w = db.data.websites.find((x) => x.uuid === row.website?.uuid);
    if (w) return w.hosting_account.uuid;
  }
  return null;
}

const ownJob = (ctx: Ctx) => {
  const v = visibility(ctx.db, ctx.actor);
  return (j: Job) => canSeeAccount(v, jobAccount(ctx.db, j));
};

/** Tính năng theo phiên bản gói hiện hành của account (D-57). */
export function featuresOf(
  db: DemoDb,
  a: DemoDb['data']['accounts'][number],
): S['AccountFeatures'] {
  const ver = db.data.package_versions.find(
    (v) => v.package_uuid === a.package.uuid && v.version === a.package.version,
  );
  const L = ver?.limits ?? db.data.packages.find((p) => p.uuid === a.package.uuid)?.limits;
  return {
    package: a.package,
    php_versions: L?.php_versions ?? [],
    php_workers_max: L?.php_workers_max ?? 1,
    ssh_allowed: L?.ssh_allowed ?? false,
    cron_min_interval_min: L?.cron_min_interval_min ?? 5,
    backup_quota_mb: L?.backup_quota_mb ?? 0,
    backup_retention: L?.backup_retention ?? {},
  };
}

/** Thông báo của từng USER: sinh lần đầu từ dữ liệu account của họ, lưu theo `notif@<user>`. */
function notesOf(ctx: Ctx): Note[] {
  const key = `notif@${ctx.actor.uuid}`;
  const cached = ctx.db.data[key] as Note[] | undefined;
  if (cached) return cached;
  const v = visibility(ctx.db, ctx.actor);
  const out: Note[] = [];
  const now = Date.parse(ctx.db.now());
  for (const c of ctx.db.data.certs) {
    const w = ctx.db.data.websites.find((x) => x.uuid === c.website?.uuid);
    if (!w || !canSeeAccount(v, w.hosting_account.uuid) || !c.not_after) continue;
    const days = Math.round((Date.parse(c.not_after) - now) / 86_400_000);
    if (days > 30) continue;
    out.push({
      uuid: ctx.db.newUuid(),
      type: 'certificate.expiring',
      severity: days <= 7 ? 'high' : 'medium',
      title: `Chứng chỉ ${w.primary_domain} sắp hết hạn`,
      body: `Còn ${days} ngày. Panel tự gia hạn trước 30 ngày nếu domain trỏ đúng.`,
      link: `/websites/${w.uuid}`,
      read_at: null,
      created_at: ctx.db.now(),
    });
  }
  for (const s of ctx.db.data.snapshots) {
    const acc = s.hosting_account;
    if (!acc || !canSeeAccount(v, acc.uuid)) continue;
    if (out.some((n) => n.type === 'backup.succeeded' && n.body.includes(acc.username))) continue;
    out.push({
      uuid: ctx.db.newUuid(),
      type: 'backup.succeeded',
      severity: 'info',
      title: 'Sao lưu hằng ngày đã xong',
      body: `Bản sao lưu mới nhất của ${acc.username} đã được kiểm chứng.`,
      link: '/backups',
      read_at: s.verified_at,
      created_at: s.taken_at,
    });
  }
  out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  ctx.db.data[key] = out;
  return out;
}

function prefsOf(ctx: Ctx): Prefs {
  const key = `prefs@${ctx.actor.uuid}`;
  ctx.db.data[key] ??= structuredClone(ctx.db.data.notification_prefs);
  return ctx.db.data[key] as Prefs;
}

const SEVERITY = (pct: number): 'info' | 'medium' | 'high' =>
  pct >= 90 ? 'high' : pct >= 80 ? 'medium' : 'info';

export function registerFeatures() {
  for (const realm of ['admin', 'portal'] as const) {
    on('get', `/api/v1/${realm}/hosting-accounts/{id}/features` as ApiPath, (ctx) => {
      const a = accountOr404(ctx);
      return isReply(a) ? a : ok(featuresOf(ctx.db, a));
    });
  }
}

export function registerPortal() {
  registerSites('portal');
  registerBackupAccess('portal');
  registerListSpecs(PORTAL_LISTS);

  on('get', P('/hosting-accounts/{id}/usage'), (ctx) => {
    const a = accountOr404(ctx);
    return isReply(a) ? a : ok(a.usage);
  });

  // ------------------------------------------------------------ tổng quan
  on('get', P('/overview'), (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const accounts = ctx.db.data.accounts.filter(
      (a) => canSeeAccount(v, a.uuid) && a.lifecycle_state !== 'terminated',
    );
    const warnings: S['PortalOverview']['warnings'] = [];
    for (const a of accounts) {
      const u = a.usage;
      const disk = Math.round((u.disk_mb.used * 100) / Math.max(u.disk_mb.limit, 1));
      if (disk >= 70)
        warnings.push({
          code: `disk_${disk >= 90 ? 90 : disk >= 80 ? 80 : 70}`,
          message: `${a.username}: dung lượng đã dùng ${disk}%`,
          severity: SEVERITY(disk),
        });
      if (u.websites.used >= u.websites.limit)
        warnings.push({
          code: 'websites_full',
          message: `${a.username}: đã dùng hết ${u.websites.limit} website của gói`,
          severity: 'medium',
        });
      if (a.lifecycle_state === 'migrating')
        warnings.push({
          code: 'account_migrating',
          message: `${a.username}: đang chuyển sang máy chủ mới, tạm thời chỉ xem (không thay đổi được)`,
          severity: 'medium',
        });
      if (a.lifecycle_state === 'suspended')
        warnings.push({
          code: 'suspended',
          message: `${a.username} đang tạm ngưng${a.suspended_reason ? `: ${a.suspended_reason}` : ''}`,
          severity: 'high',
        });
    }
    const own = ownJob(ctx);
    return ok({
      accounts: accounts.map((a) => ({
        hosting_account: { uuid: a.uuid, username: a.username },
        lifecycle_state: a.lifecycle_state,
        usage: a.usage,
      })),
      warnings,
      recent_jobs: ctx.db.data.jobs
        .filter(own)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5)
        .map((j) => ({ uuid: j.uuid, type: j.type, state: j.state, progress: j.progress })),
      notifications_unread: notesOf(ctx).filter((n) => n.read_at === null).length,
    });
  });

  // ------------------------------------------------------------ job của tôi
  on('get', P('/jobs'), (ctx) => {
    const rows = ctx.db.data.jobs.filter(ownJob(ctx));
    return page(ctx, rows as unknown as Record<string, unknown>[], {
      search: ['type'],
      filters: { state: 'state' },
      sort: '-created_at',
    });
  });
  on('get', P('/jobs/{id}'), (ctx) => {
    const j = findOr404(ctx.db.data.jobs.filter(ownJob(ctx)), ctx.params.id, 'job');
    return isReply(j) ? j : ok(j);
  });
  on('get', P('/jobs/{id}/logs'), (ctx) => {
    const j = findOr404(ctx.db.data.jobs.filter(ownJob(ctx)), ctx.params.id, 'job');
    return isReply(j) ? j : page(ctx, logsOf(j));
  });
  for (const action of ['cancel', 'retry'] as const) {
    on('post', P(`/jobs/{id}:${action}`), (ctx) => jobActions(ctx, action, ownJob(ctx)));
  }

  // ------------------------------------------------------------ hồ sơ
  on('get', P('/profile'), (ctx) => {
    const u = ctx.db.data.users.find((x) => x.uuid === ctx.actor.uuid);
    return u ? ok(u) : problem(404, 'not_found', 'Không tìm thấy người dùng');
  });
  on('patch', P('/profile'), (ctx) => {
    const u = ctx.db.data.users.find((x) => x.uuid === ctx.actor.uuid);
    if (!u) return problem(404, 'not_found', 'Không tìm thấy người dùng');
    const b = (ctx.body ?? {}) as { name?: string; locale?: string; timezone?: string };
    if (b.name !== undefined && (b.name.trim() === '' || b.name.length > 120))
      return invalid('Tên từ 1 đến 120 ký tự.');
    if (b.locale !== undefined && b.locale !== 'vi' && b.locale !== 'en')
      return invalid('Ngôn ngữ: vi hoặc en.');
    if (b.timezone !== undefined && !/^[A-Za-z]+(\/[A-Za-z_+-]+)*$/.test(b.timezone))
      return invalid('Múi giờ không hợp lệ.');
    const before = { name: u.name, locale: u.locale, timezone: u.timezone };
    if (b.name !== undefined) u.name = b.name.trim();
    if (b.locale !== undefined) u.locale = b.locale as typeof u.locale;
    if (b.timezone !== undefined) u.timezone = b.timezone;
    u.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'user.profile.update',
      resource: { type: 'user', uuid: u.uuid },
      changes: Object.fromEntries(
        Object.entries(before)
          .filter(([k, x]) => x !== (u as Record<string, unknown>)[k])
          .map(([k, x]) => [k, [x, (u as Record<string, unknown>)[k]]]),
      ),
    });
    return ok(u);
  });

  // ------------------------------------------------------------ thông báo
  on('get', P('/notifications'), (ctx) =>
    page(ctx, notesOf(ctx) as unknown as Record<string, unknown>[], {
      filters: { severity: 'severity' },
      sort: '-created_at',
    }),
  );
  on('post', P('/notifications/{id}:read'), (ctx) => {
    const n = notesOf(ctx).find((x) => x.uuid === ctx.params.id);
    if (!n) return problem(404, 'not_found', 'Không tìm thấy thông báo');
    n.read_at ??= ctx.db.now();
    return noContent();
  });
  on('post', P('/notifications:read-all'), (ctx) => {
    for (const n of notesOf(ctx)) n.read_at ??= ctx.db.now();
    return noContent();
  });
  on('get', P('/notification-preferences'), (ctx) => ok(prefsOf(ctx)));
  on('patch', P('/notification-preferences'), (ctx) => {
    const cur = prefsOf(ctx);
    const want = ctx.request.headers.get('If-Match')?.replace(/"/g, '');
    if (want && want !== cur.updated_at)
      return problem(412, 'precondition_failed', 'Dữ liệu đã thay đổi, tải lại rồi thử lại');
    const b = (ctx.body ?? {}) as Partial<Prefs>;
    const CH = ['email', 'telegram', 'in_app'];
    if (b.channels && !Object.keys(b.channels).every((k) => CH.includes(k)))
      return invalid('Kênh thông báo không hợp lệ.');
    for (const list of Object.values(b.events ?? {}))
      if (!list.every((c) => CH.includes(c))) return invalid('Kênh thông báo không hợp lệ.');
    if (b.channels) cur.channels = { ...cur.channels, ...b.channels };
    if (b.events) cur.events = { ...b.events };
    cur.updated_at = ctx.db.now();
    return ok(cur);
  });

  // ------------------------------------------------------------ terminal (gói có SSH)
  on('post', P('/terminal/sessions'), (ctx) => {
    const b = (ctx.body ?? {}) as { mode?: string; hosting_account_uuid?: string | null };
    if (b.mode !== 'account')
      return problem(403, 'forbidden', 'Portal chỉ mở terminal của account');
    const v = visibility(ctx.db, ctx.actor);
    const a = ctx.db.data.accounts.find((x) => x.uuid === b.hosting_account_uuid);
    if (!a || !canSeeAccount(v, a.uuid)) return invalid('Chọn tài khoản hosting của bạn.');
    if (a.lifecycle_state !== 'active')
      return problem(409, 'invalid_state_transition', 'Tài khoản không ở trạng thái hoạt động');
    if (!featuresOf(ctx.db, a).ssh_allowed)
      return problem(
        409,
        'package_limit_reached',
        'Gói hosting không có SSH',
        'Liên hệ quản trị để đổi gói.',
      );
    const tpl = ctx.db.data.terminal as S['TerminalTicket'];
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'terminal.open',
      resource: { type: 'hosting_account', uuid: a.uuid },
      changes: { mode: 'account' },
    });
    return created({
      ...tpl,
      ticket: `tkt_${ctx.db.newUuid().slice(-12)}`,
      session_uuid: ctx.db.newUuid(),
      mode: 'account',
      unix_user: a.username,
      expires_at: new Date(Date.now() + 30_000 + 7 * 3600_000)
        .toISOString()
        .replace(/\.\d{3}Z$/, '+07:00'),
    });
  });
}
