import type { DemoDb } from '../db';
import { findOr404, isReply, page, type ListOptions } from '../list';
import { ok, on, problem, type ApiPath, type Ctx, type Reply } from '../router';
import { byAccount, canSeeAccount, canSeeServer, scopeRows, visibility } from '../scope';

type Row = Record<string, unknown> & { uuid?: string };
type Coll = (db: DemoDb) => Row[];

const ACC = (r: Row) => (r.hosting_account as { uuid: string } | null | undefined)?.uuid;

export interface ListSpec extends ListOptions {
  path: ApiPath;
  rows: Coll;
  /** Cách lọc theo phạm vi vai trò: theo account, theo server, hoặc chỉ SUPER_ADMIN thấy. */
  scope?: 'account' | 'server' | 'self' | 'none';
  detail?: ApiPath;
  what?: string;
}

const d =
  (k: string): Coll =>
  (db) =>
    db.data[k] as Row[];

/** Bảng list/detail: đọc thẳng từ dữ liệu demo, lọc theo vai trò, phân trang theo contract. */
export const ADMIN_LISTS: ListSpec[] = [
  {
    path: '/api/v1/admin/servers',
    detail: '/api/v1/admin/servers/{id}',
    rows: d('servers'),
    scope: 'server',
    search: ['name', 'hostname', 'ip_addresses'],
    sort: 'name',
    what: 'server',
  },
  {
    path: '/api/v1/admin/hosting-packages',
    detail: '/api/v1/admin/hosting-packages/{id}',
    rows: d('packages'),
    scope: 'none',
    search: ['name', 'code'],
    what: 'gói hosting',
  },
  {
    path: '/api/v1/admin/hosting-accounts',
    detail: '/api/v1/admin/hosting-accounts/{id}',
    rows: d('accounts'),
    scope: 'account',
    search: ['username', 'owner.name', 'owner.email'],
    filters: { server: 'server.uuid', lifecycle_state: 'lifecycle_state' },
    sort: 'username',
    what: 'tài khoản hosting',
  },
  {
    path: '/api/v1/admin/websites',
    detail: '/api/v1/admin/websites/{id}',
    rows: d('websites'),
    scope: 'account',
    search: ['primary_domain', 'hosting_account.username'],
    filters: { hosting_account: 'hosting_account.uuid', server: 'server.uuid' },
    sort: 'primary_domain',
    what: 'website',
  },
  {
    path: '/api/v1/admin/databases',
    detail: '/api/v1/admin/databases/{id}',
    rows: d('databases'),
    scope: 'account',
    search: ['name', 'hosting_account.username'],
    filters: { hosting_account: 'hosting_account.uuid', server: 'server.uuid' },
    sort: 'name',
    what: 'database',
  },
  {
    path: '/api/v1/admin/database-users',
    rows: d('db_users'),
    scope: 'account',
    search: ['username'],
    filters: { hosting_account: 'hosting_account.uuid' },
  },
  {
    path: '/api/v1/admin/sftp-accounts',
    rows: d('sftp'),
    scope: 'account',
    search: ['username'],
    filters: { hosting_account: 'hosting_account.uuid' },
  },
  {
    path: '/api/v1/admin/ssh-keys',
    rows: d('ssh_keys'),
    scope: 'account',
    search: ['name', 'fingerprint'],
    filters: { hosting_account: 'hosting_account.uuid' },
  },
  {
    path: '/api/v1/admin/cron-jobs',
    rows: d('cron'),
    scope: 'account',
    search: ['command', 'schedule'],
    filters: { hosting_account: 'hosting_account.uuid' },
  },
  {
    path: '/api/v1/admin/certificates',
    rows: d('certs'),
    scope: 'account',
    search: ['website.primary_domain', 'issuer'],
    sort: 'not_after',
  },
  { path: '/api/v1/admin/dns/zones', rows: d('dns_zones'), scope: 'account', search: ['name'] },
  {
    path: '/api/v1/admin/backup-destinations',
    detail: '/api/v1/admin/backup-destinations/{id}',
    rows: d('backup_dests'),
    scope: 'none',
    search: ['name'],
    what: 'đích backup',
  },
  {
    path: '/api/v1/admin/backup-policies',
    detail: '/api/v1/admin/backup-policies/{id}',
    rows: d('backup_policies'),
    scope: 'none',
    search: ['name'],
    what: 'chính sách backup',
  },
  {
    path: '/api/v1/admin/backup-snapshots',
    rows: d('snapshots'),
    scope: 'account',
    search: ['hosting_account.username', 'restic_snapshot_id'],
    filters: {
      hosting_account: 'hosting_account.uuid',
      destination: 'destination.uuid',
      scope_type: 'scope_type',
    },
    sort: '-taken_at',
  },
  {
    path: '/api/v1/admin/backup-repositories',
    rows: d('backup_repos'),
    scope: 'account',
    search: ['hosting_account.username', 'destination.name', 'path'],
    filters: { hosting_account: 'hosting_account.uuid', destination: 'destination.uuid' },
    sort: 'path',
  },
  {
    path: '/api/v1/admin/backup-verifications',
    rows: d('backup_verifications'),
    scope: 'account',
    search: ['hosting_account.username', 'destination.name'],
    filters: { hosting_account: 'hosting_account.uuid', destination: 'destination.uuid' },
    sort: '-started_at',
  },
  {
    path: '/api/v1/admin/restores',
    detail: '/api/v1/admin/restores/{id}',
    rows: d('restores'),
    scope: 'account',
    sort: '-created_at',
    what: 'lần khôi phục',
  },
  {
    path: '/api/v1/admin/account-migrations',
    detail: '/api/v1/admin/account-migrations/{id}',
    rows: d('migrations'),
    scope: 'account',
    what: 'lần chuyển server',
  },
  { path: '/api/v1/admin/purge-records', rows: d('purges'), scope: 'account' },
  {
    path: '/api/v1/admin/jobs',
    detail: '/api/v1/admin/jobs/{id}',
    rows: d('jobs'),
    scope: 'server',
    search: ['type'],
    filters: { state: 'state' },
    sort: '-created_at',
    what: 'job',
  },
  {
    path: '/api/v1/admin/users',
    detail: '/api/v1/admin/users/{id}',
    rows: d('users'),
    scope: 'none',
    search: ['name', 'email'],
    filters: { realm: 'realm' },
    what: 'người dùng',
  },
  { path: '/api/v1/admin/roles', rows: d('roles'), scope: 'none' },
  {
    path: '/api/v1/admin/security/events',
    rows: d('security_events'),
    scope: 'server',
    search: ['message', 'source_ip'],
    filters: { severity: 'severity' },
    sort: '-at',
  },
  { path: '/api/v1/admin/security/malware/scans', rows: d('malware_scans'), scope: 'account' },
  { path: '/api/v1/admin/security/quarantine', rows: d('quarantine'), scope: 'account' },
  {
    path: '/api/v1/admin/compose-projects',
    detail: '/api/v1/admin/compose-projects/{id}',
    rows: d('compose'),
    scope: 'server',
    search: ['name'],
    what: 'compose project',
  },
  { path: '/api/v1/admin/registries', rows: d('registries'), scope: 'none' },
  {
    path: '/api/v1/admin/wordpress/sites',
    rows: d('wordpress'),
    scope: 'account',
    search: ['website.primary_domain'],
  },
  {
    path: '/api/v1/admin/git-repositories',
    detail: '/api/v1/admin/git-repositories/{id}',
    rows: d('git_repositories'),
    scope: 'account',
    search: ['repo_url', 'website.primary_domain'],
    filters: { hosting_account: 'hosting_account.uuid' },
    what: 'kho Git',
  },
  {
    path: '/api/v1/admin/alert-rules',
    detail: '/api/v1/admin/alert-rules/{id}',
    rows: d('alert_rules'),
    scope: 'none',
    what: 'luật cảnh báo',
  },
  { path: '/api/v1/admin/alerts', rows: d('alerts'), scope: 'none', sort: '-started_at' },
  { path: '/api/v1/admin/uptime-checks', rows: d('uptime'), scope: 'none' },
  {
    path: '/api/v1/admin/notifications',
    rows: d('notifications'),
    scope: 'none',
    sort: '-created_at',
  },
  {
    path: '/api/v1/admin/audit-logs',
    rows: d('audit'),
    scope: 'self',
    search: ['action', 'actor.name'],
    filters: { action: 'action', actor: 'actor.uuid' },
    sort: '-at',
  },
  { path: '/api/v1/admin/api-tokens', rows: d('api_tokens'), scope: 'none' },
];

function visibleRows(ctx: Ctx, spec: ListSpec): Row[] | Reply {
  const v = visibility(ctx.db, ctx.actor);
  const rows = spec.rows(ctx.db);
  switch (spec.scope) {
    case 'account': {
      // Bản ghi chỉ gắn website (chứng chỉ SSL): suy ra account qua website.
      const siteAcc = (r: Row) => {
        const w = (r.website as { uuid: string } | undefined)?.uuid;
        return ctx.db.data.websites.find((x) => x.uuid === w)?.hosting_account.uuid;
      };
      return byAccount(v, rows, (r) => (r.username ? r.uuid : (ACC(r) ?? siteAcc(r))));
    }
    case 'server':
      return v.all
        ? rows
        : rows.filter((r) => {
            const s =
              (r.server as { uuid: string } | null | undefined)?.uuid ??
              (r.hostname ? r.uuid : undefined);
            return s !== undefined && canSeeServer(v, s);
          });
    case 'self':
      return v.all
        ? rows
        : rows.filter((r) => (r.actor as { uuid: string } | null)?.uuid === ctx.actor.uuid);
    case 'none':
    default:
      return rows;
  }
}

/** Đăng ký GET danh sách (+ chi tiết) theo bảng spec. Portal dùng lại với đường dẫn portal. */
export function registerListSpecs(specs: ListSpec[]) {
  for (const spec of specs) {
    on('get', spec.path, (ctx) => {
      const rows = visibleRows(ctx, spec);
      return isReply(rows) ? rows : page(ctx, rows, spec);
    });
    if (spec.detail) {
      on('get', spec.detail, (ctx) => {
        const rows = visibleRows(ctx, spec);
        if (isReply(rows)) return rows;
        // Ngoài phạm vi → 404 (không lộ sự tồn tại), giống backend thật.
        const x = findOr404(rows as { uuid: string }[], ctx.params.id, spec.what ?? 'bản ghi');
        return isReply(x) ? x : ok(x);
      });
    }
  }
}

export function registerAdminLists() {
  registerListSpecs(ADMIN_LISTS);

  const singletons: [ApiPath, string][] = [
    ['/api/v1/admin/security/overview', 'security_overview'],
    // /security/ssh, /security/fail2ban: governance.ts (bắt buộc ?server= như API thật).
    ['/api/v1/admin/security/ip-allowlist', 'ip_allowlist'],
    ['/api/v1/admin/notification-preferences', 'notification_prefs'],
  ];
  for (const [path, key] of singletons) on('get', path, (ctx) => ok(ctx.db.data[key]));

  on('get', '/api/v1/admin/settings/{group}', (ctx) => {
    const s = (ctx.db.data.settings as Record<string, unknown>)[ctx.params.group ?? ''];
    return s === undefined
      ? problem(404, 'not_found', 'Không có nhóm cài đặt này')
      : ok({ group: ctx.params.group, values: s });
  });

  on('get', '/api/v1/admin/servers/{id}/capacity', (ctx) => {
    const deny = serverGuard(ctx);
    if (deny) return deny;
    const s = ctx.db.data.servers.find((x) => x.uuid === ctx.params.id);
    const base = ctx.db.data.capacity as Record<string, unknown>;
    return ok({
      ...base,
      server: { uuid: s?.uuid, name: s?.name },
      account_count: s?.account_count ?? 0,
    });
  });
  // Gợi ý đặt account (D-92): lọc (kết nối, nhận account, sẵn sàng, đĩa ≥ 15 %), rồi chấm điểm theo
  // tài nguyên còn trống và % cam kết (tổng hạn mức đĩa các account / dung lượng đĩa). Chỉ gợi ý.
  on('get', '/api/v1/admin/placement/suggestions', (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const rows = ctx.db.data.servers
      .filter((s) => canSeeServer(v, s.uuid))
      .map((s) => {
        const r = s.resources;
        const ram = 100 - Math.round((r.ram_used_mb * 100) / Math.max(r.ram_mb, 1));
        const freeDisk = 100 - Math.round((r.disk_used_mb * 100) / Math.max(r.disk_mb, 1));
        const quota = ctx.db.data.accounts
          .filter((a) => a.server.uuid === s.uuid)
          .reduce((n, a) => n + (a.usage.disk_mb.limit ?? 0), 0);
        const commit = Math.round((quota * 100) / Math.max(r.disk_mb, 1));
        const out: string[] = [];
        if (s.connection !== 'online')
          out.push(
            s.last_seen_at
              ? `Mất kết nối từ ${s.last_seen_at.slice(11, 16)}`
              : 'Agent chưa kết nối',
          );
        if (!s.accepting_new_accounts) out.push('Đang tắt nhận account mới');
        if (s.status !== 'ready' && s.connection === 'online') out.push('Máy chưa sẵn sàng');
        if (freeDisk < 15) out.push(`Đĩa còn ${freeDisk}% (cần ≥ 15%)`);
        const eligible = out.length === 0;
        const score = eligible
          ? Math.max(1, Math.min(99, Math.round(ram * 0.4 + freeDisk * 0.3 + (100 - commit) * 0.3)))
          : 0;
        return {
          server: { uuid: s.uuid, name: s.name },
          score,
          reasons: eligible
            ? [`Còn ${ram}% RAM chưa dùng`, `Đĩa còn ${freeDisk}%`, `${s.account_count} account`]
            : [],
          accepting_new: s.accepting_new_accounts,
          eligible,
          excluded_reasons: out,
          commit_pct: commit,
        };
      })
      .sort((a, b) => b.score - a.score);
    return page(ctx, rows);
  });

  on('get', '/api/v1/admin/hosting-accounts/{id}/usage', (ctx) => {
    const a = accountOr404(ctx);
    return isReply(a) ? a : ok(a.usage);
  });
  on('get', '/api/v1/admin/hosting-packages/{id}/versions', (ctx) =>
    page(
      ctx,
      ctx.db.data.package_versions.filter((v) => v.package_uuid === ctx.params.id),
      { sort: '-version' },
    ),
  );
  on('get', '/api/v1/admin/jobs/{id}/logs', (ctx) => {
    const j = ctx.db.data.jobs.find((x) => x.uuid === ctx.params.id);
    if (!j) return problem(404, 'not_found', 'Không tìm thấy job');
    return page(ctx, logsOf(j));
  });
  on('get', '/api/v1/admin/users/{id}/scopes', (ctx) => {
    const u = ctx.db.data.users.find((x) => x.uuid === ctx.params.id);
    if (!u) return problem(404, 'not_found', 'Không tìm thấy người dùng');
    return page(ctx, scopeRows(ctx.db, u.uuid) as unknown as Row[]);
  });
}

function serverGuard(ctx: Ctx): Reply | null {
  const v = visibility(ctx.db, ctx.actor);
  const exists = ctx.db.data.servers.some((s) => s.uuid === ctx.params.id);
  return exists && canSeeServer(v, ctx.params.id ?? '')
    ? null
    : problem(404, 'not_found', 'Không tìm thấy server');
}

export function accountOr404(ctx: Ctx) {
  const v = visibility(ctx.db, ctx.actor);
  const a = ctx.db.data.accounts.find((x) => x.uuid === ctx.params.id);
  return a && canSeeAccount(v, a.uuid)
    ? a
    : problem(404, 'not_found', 'Không tìm thấy tài khoản hosting');
}

/** Log job: log mẫu cho job có sẵn, log sinh theo bước cho job mới. */
export function logsOf(j: DemoDb['data']['jobs'][number]): Row[] {
  const out: Row[] = [];
  for (const s of j.steps) {
    if (s.started_at)
      out.push({ seq: s.seq, at: s.started_at, level: 'info', message: `Bắt đầu ${s.op}` });
    if (s.state === 'succeeded' && s.finished_at)
      out.push({ seq: s.seq, at: s.finished_at, level: 'info', message: `${s.op}: OK` });
    if (s.state === 'failed' && s.finished_at)
      out.push({
        seq: s.seq,
        at: s.finished_at,
        level: 'error',
        message: j.error?.message ?? `${s.op} thất bại`,
      });
  }
  return out;
}
