import type { components as A } from '@/api/generated/admin/schema';
import type { DemoDb } from '../db';
import { created, noContent, ok, on, problem, type Ctx, type Reply } from '../router';
import { page } from '../list';
import { canSeeAccount, canSeeServer, visibility } from '../scope';
import { actorRef, startJob } from './writes';

type S = A['schemas'];
type Account = S['HostingAccount'];
type Package = S['HostingPackage'];
type Limits = S['PackageLimits'];

const invalid = (detail: string) =>
  problem(422, 'validation_failed', 'Dữ liệu không hợp lệ', detail);
const SA_ONLY = (ctx: Ctx) =>
  ctx.actor.role === 'SUPER_ADMIN'
    ? null
    : problem(403, 'forbidden', 'Chỉ Super Admin được thực hiện thao tác này');
const isReply = (x: unknown): x is Reply =>
  typeof x === 'object' && x !== null && 'status' in x && !('uuid' in x);

const USERNAME = /^[a-z][a-z0-9]{2,15}$/;
const CODE = /^[a-z][a-z0-9-]{1,31}$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** Tên hệ thống không dùng làm username (khớp contracts/agent-ops Username). */
const RESERVED = new Set(['root', 'admin', 'www', 'nginx', 'mysql', 'postgres', 'itso', 'backup']);

const DAY = 86_400_000;
const iso = (ms: number) =>
  new Date(ms + 7 * 3600_000).toISOString().replace(/\.\d{3}Z$/, '+07:00');

/** Kiểm giới hạn gói như backend (PackageLimits). Trả thông báo lỗi hoặc null. */
export function limitsError(l: Partial<Limits> | undefined): string | null {
  if (!l) return 'Thiếu giới hạn gói.';
  const pos = [
    'disk_mb',
    'inode_limit',
    'cpu_percent',
    'ram_mb',
    'tasks_max',
    'php_workers_max',
    'cron_min_interval_min',
  ] as const;
  for (const k of pos) if (!Number.isInteger(l[k]) || (l[k] as number) < 1) return `${k} ≥ 1.`;
  const nonneg = [
    'website_limit',
    'alias_domain_limit',
    'subdomain_limit',
    'database_limit',
    'db_user_limit',
    'ftp_limit',
    'cron_limit',
    'backup_quota_mb',
  ] as const;
  for (const k of nonneg) if (!Number.isInteger(l[k]) || (l[k] as number) < 0) return `${k} ≥ 0.`;
  if (!l.io_weight || l.io_weight < 1 || l.io_weight > 10000) return 'io_weight từ 1 đến 10000.';
  if (!l.retention_days_after_terminate || l.retention_days_after_terminate < 30) {
    return 'Giữ dữ liệu sau khi chấm dứt tối thiểu 30 ngày (D-46).';
  }
  if (!l.php_versions?.length) return 'Chọn ít nhất một phiên bản PHP.';
  return null;
}

function accountOf(ctx: Ctx): Account | Reply {
  const v = visibility(ctx.db, ctx.actor);
  const a = ctx.db.data.accounts.find((x) => x.uuid === ctx.params.id);
  return a && canSeeAccount(v, a.uuid)
    ? a
    : problem(404, 'not_found', 'Không tìm thấy tài khoản hosting');
}
const accRef = (a: Account) => ({ uuid: a.uuid, username: a.username });
const resource = (a: Account) => ({ type: 'hosting_account' as const, uuid: a.uuid });

function lifecycle(
  db: DemoDb,
  a: Account,
  to: Account['lifecycle_state'],
  reason: string | null,
  ctx: Ctx,
  jobUuid: string | null = null,
) {
  const list = (db.data[`lifecycle@${a.uuid}`] ??=
    [] as S['LifecycleEvent'][]) as S['LifecycleEvent'][];
  list.unshift({
    uuid: db.newUuid(),
    from_state: a.lifecycle_state,
    to_state: to,
    reason,
    actor: actorRef(ctx),
    job_uuid: jobUuid,
    at: db.now(),
  } as S['LifecycleEvent']);
  a.lifecycle_state = to;
  a.updated_at = db.now();
}

/** Đếm lại số account theo server/gói/phiên bản sau khi thêm, đổi gói, chuyển server. */
function recount(db: DemoDb) {
  const live = db.data.accounts.filter(
    (a) => a.lifecycle_state !== 'terminated' && a.lifecycle_state !== 'purged',
  );
  for (const s of db.data.servers)
    s.account_count = live.filter((a) => a.server.uuid === s.uuid).length;
  for (const p of db.data.packages)
    p.account_count = live.filter((a) => a.package.uuid === p.uuid).length;
  for (const v of db.data.package_versions) {
    v.account_count = live.filter(
      (a) => a.package.uuid === v.package_uuid && a.package.version === v.version,
    ).length;
  }
}

export function registerHosting() {
  // ---------------------------------------------------------------- gói hosting
  on('post', '/api/v1/admin/hosting-packages', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const b = (ctx.body ?? {}) as {
      code?: string;
      name?: string;
      description?: string | null;
      limits?: Limits;
    };
    if (!b.code || !CODE.test(b.code)) return invalid('Mã gói: chữ thường, số, gạch ngang.');
    if (!b.name || b.name.length > 80) return invalid('Tên gói bắt buộc (≤ 80 ký tự).');
    const err = limitsError(b.limits);
    if (err) return invalid(err);
    if (ctx.db.data.packages.some((p) => p.code === b.code)) {
      return problem(409, 'conflict', 'Mã gói đã tồn tại');
    }
    const uuid = ctx.db.newUuid();
    const pkg = {
      uuid,
      code: b.code,
      name: b.name,
      description: b.description ?? null,
      current_version: 1,
      is_active: true,
      account_count: 0,
      limits: b.limits as Limits,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    } satisfies Package;
    ctx.db.data.packages.push(pkg);
    ctx.db.data.package_versions.push({
      uuid: ctx.db.newUuid(),
      package_uuid: uuid,
      version: 1,
      limits: structuredClone(b.limits as Limits),
      account_count: 0,
      created_by: actorRef(ctx),
      created_at: ctx.db.now(),
    });
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'hosting_package.create',
      resource: { type: 'hosting_package', uuid },
    });
    return created(pkg);
  });

  on('patch', '/api/v1/admin/hosting-packages/{id}', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const p = ctx.db.data.packages.find((x) => x.uuid === ctx.params.id);
    if (!p) return problem(404, 'not_found', 'Không tìm thấy gói hosting');
    const b = (ctx.body ?? {}) as {
      name?: string;
      description?: string | null;
      is_active?: boolean;
      limits?: Limits;
    };
    if (b.name !== undefined && (!b.name || b.name.length > 80))
      return invalid('Tên gói không hợp lệ.');
    if (b.limits !== undefined) {
      const err = limitsError(b.limits);
      if (err) return invalid(err);
    }
    const changed = b.limits !== undefined && JSON.stringify(b.limits) !== JSON.stringify(p.limits);
    if (b.name !== undefined) p.name = b.name;
    if (b.description !== undefined) p.description = b.description;
    if (b.is_active !== undefined) p.is_active = b.is_active;
    if (changed) {
      // D-43: giới hạn đổi → phiên bản mới bất biến; account cũ giữ phiên bản cũ tới khi chuyển.
      p.current_version += 1;
      p.limits = structuredClone(b.limits as Limits);
      ctx.db.data.package_versions.push({
        uuid: ctx.db.newUuid(),
        package_uuid: p.uuid,
        version: p.current_version,
        limits: structuredClone(b.limits as Limits),
        account_count: 0,
        created_by: actorRef(ctx),
        created_at: ctx.db.now(),
      });
    }
    p.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'hosting_package.update',
      resource: { type: 'hosting_package', uuid: p.uuid },
      changes: changed ? { version: p.current_version } : (b as Record<string, unknown>),
    });
    return ok(p);
  });

  on('delete', '/api/v1/admin/hosting-packages/{id}', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const i = ctx.db.data.packages.findIndex((x) => x.uuid === ctx.params.id);
    const p = ctx.db.data.packages[i];
    if (!p) return problem(404, 'not_found', 'Không tìm thấy gói hosting');
    if (
      ctx.db.data.accounts.some((a) => a.package.uuid === p.uuid && a.lifecycle_state !== 'purged')
    ) {
      return problem(
        409,
        'conflict',
        'Gói đang có tài khoản sử dụng; hãy ngừng bán (is_active = false) thay vì xóa',
      );
    }
    ctx.db.data.packages.splice(i, 1);
    return noContent();
  });

  on('post', '/api/v1/admin/hosting-packages/{id}/versions/{version}:migrate-accounts', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const p = ctx.db.data.packages.find((x) => x.uuid === ctx.params.id);
    const version = Number(ctx.params.version);
    const v = ctx.db.data.package_versions.find(
      (x) => x.package_uuid === p?.uuid && x.version === version,
    );
    if (!p || !v) return problem(404, 'not_found', 'Không tìm thấy phiên bản gói');
    const targets = ctx.db.data.accounts.filter(
      (a) =>
        a.package.uuid === p.uuid &&
        a.package.version !== version &&
        a.lifecycle_state === 'active',
    );
    if (targets.length === 0)
      return problem(409, 'conflict', 'Không có tài khoản nào cần chuyển phiên bản');
    return startJob(ctx, {
      type: 'hosting_package.migrate_accounts',
      resource: { type: 'hosting_package', uuid: p.uuid },
      ops: ['quota.apply', 'php.pool.apply'],
      changes: { version, accounts: targets.map((a) => a.username) },
      onDone: (db) => {
        for (const a of targets) a.package.version = version;
        recount(db);
      },
    });
  });

  // ---------------------------------------------------------------- tài khoản hosting
  on('post', '/api/v1/admin/hosting-accounts', (ctx) => {
    const b = (ctx.body ?? {}) as {
      owner_user_uuid?: string;
      package_uuid?: string;
      server_uuid?: string;
      username?: string;
      primary_domain?: string | null;
    };
    const v = visibility(ctx.db, ctx.actor);
    const owner = ctx.db.data.users.find(
      (u) => u.uuid === b.owner_user_uuid && u.realm === 'portal',
    );
    if (!owner) return invalid('Chọn người dùng Portal làm chủ sở hữu.');
    const pkg = ctx.db.data.packages.find((p) => p.uuid === b.package_uuid && p.is_active);
    if (!pkg) return invalid('Chọn gói hosting đang bán.');
    const srv = ctx.db.data.servers.find((s) => s.uuid === b.server_uuid);
    if (!srv || !canSeeServer(v, srv.uuid)) return invalid('Chọn máy chủ trong phạm vi của bạn.');
    if (!srv.accepting_new_accounts)
      return problem(409, 'conflict', 'Máy chủ đang không nhận tài khoản mới');
    if (!b.username || !USERNAME.test(b.username) || RESERVED.has(b.username)) {
      return invalid(
        'Username: 3–16 ký tự, bắt đầu bằng chữ, chỉ chữ thường và số, không dùng tên hệ thống.',
      );
    }
    if (ctx.db.data.accounts.some((a) => a.username === b.username)) {
      return problem(409, 'conflict', 'Username đã tồn tại');
    }
    if (b.primary_domain && !DOMAIN.test(b.primary_domain)) return invalid('Domain không hợp lệ.');
    const uuid = ctx.db.newUuid();
    const uid = 20000 + ctx.db.data.accounts.length + 100;
    const L = pkg.limits;
    const acc = {
      uuid,
      username: b.username,
      server: { uuid: srv.uuid, name: srv.name },
      package: { uuid: pkg.uuid, code: pkg.code, name: pkg.name, version: pkg.current_version },
      owner: { uuid: owner.uuid, name: owner.name, email: owner.email },
      uid,
      home_path: `/home/${b.username}`,
      lifecycle_state: 'pending',
      suspended_reason: null,
      terminated_at: null,
      purge_after: null,
      legal_hold: false,
      usage: {
        disk_mb: { used: 0, limit: L.disk_mb },
        inodes: { used: 0, limit: L.inode_limit },
        cpu_percent: { used: 0, limit: L.cpu_percent },
        ram_mb: { used: 0, limit: L.ram_mb },
        websites: { used: 0, limit: L.website_limit },
        databases: { used: 0, limit: L.database_limit },
        ftp_accounts: { used: 0, limit: L.ftp_limit },
        cron_jobs: { used: 0, limit: L.cron_limit },
        backup_mb: { used: 0, limit: L.backup_quota_mb },
        bandwidth_mb_30d: 0,
        measured_at: ctx.db.now(),
      },
      status: 'provisioning',
      spec_version: 1,
      observed_version: 0,
      drift: null,
      observed_at: null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    } as Account;
    ctx.db.data.accounts.push(acc);
    lifecycle(ctx.db, acc, 'provisioning', 'Tạo account', ctx);
    recount(ctx.db);
    const ops = ['account.ensure', 'quota.apply', 'php.pool.apply'];
    if (b.primary_domain) ops.push('nginx.vhost.apply', 'cert.issue');
    return startJob(ctx, {
      type: 'hosting_account.create',
      resource: resource(acc),
      ops,
      server: acc.server,
      changes: { username: acc.username, package: pkg.code, domain: b.primary_domain ?? null },
      onDone: (db) => {
        lifecycle(db, acc, 'active', null, ctx);
        acc.status = 'ready';
        acc.observed_version = 1;
        acc.observed_at = db.now();
        if (b.primary_domain) {
          const tpl = db.data.websites[0] as S['Website'];
          db.data.websites.push({
            ...structuredClone(tpl),
            uuid: db.newUuid(),
            hosting_account: accRef(acc),
            server: acc.server,
            primary_domain: b.primary_domain,
            domains_count: 1,
            php_version: L.php_versions.at(-1) ?? tpl.php_version,
            spec_version: 1,
            observed_version: 1,
            created_at: db.now(),
            updated_at: db.now(),
          });
          acc.usage.websites.used = 1;
        }
      },
    });
  });

  on('patch', '/api/v1/admin/hosting-accounts/{id}', (ctx) => {
    const a = accountOf(ctx);
    if (isReply(a)) return a;
    const b = (ctx.body ?? {}) as { owner_user_uuid?: string; legal_hold?: boolean };
    if (b.legal_hold !== undefined) {
      const deny = SA_ONLY(ctx);
      if (deny) return deny;
      a.legal_hold = b.legal_hold;
    }
    if (b.owner_user_uuid !== undefined) {
      const u = ctx.db.data.users.find((x) => x.uuid === b.owner_user_uuid && x.realm === 'portal');
      if (!u) return invalid('Chủ sở hữu phải là người dùng Portal.');
      a.owner = { uuid: u.uuid, name: u.name, email: u.email };
    }
    a.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'hosting_account.update',
      resource: resource(a),
      server: a.server,
      changes: b,
    });
    return ok(a);
  });

  on('post', '/api/v1/admin/hosting-accounts/{id}:suspend', (ctx) => {
    const a = accountOf(ctx);
    if (isReply(a)) return a;
    const reason = (ctx.body as { reason?: string } | undefined)?.reason ?? '';
    if (reason.trim().length < 5) return invalid('Lý do tối thiểu 5 ký tự.');
    if (a.lifecycle_state !== 'active')
      return problem(409, 'conflict', 'Chỉ khóa được tài khoản đang hoạt động');
    return startJob(ctx, {
      type: 'hosting_account.suspend',
      resource: resource(a),
      ops: ['account.suspend', 'nginx.vhost.apply'],
      server: a.server,
      changes: { reason },
      onDone: (db) => {
        lifecycle(db, a, 'suspended', reason, ctx);
        a.suspended_reason = reason;
        a.status = 'suspended';
      },
    });
  });

  on('post', '/api/v1/admin/hosting-accounts/{id}:unsuspend', (ctx) => {
    const a = accountOf(ctx);
    if (isReply(a)) return a;
    if (a.lifecycle_state !== 'suspended')
      return problem(409, 'conflict', 'Tài khoản không ở trạng thái bị khóa');
    return startJob(ctx, {
      type: 'hosting_account.unsuspend',
      resource: resource(a),
      ops: ['account.unsuspend', 'nginx.vhost.apply'],
      server: a.server,
      onDone: (db) => {
        lifecycle(db, a, 'active', null, ctx);
        a.suspended_reason = null;
        a.status = 'ready';
      },
    });
  });

  on('post', '/api/v1/admin/hosting-accounts/{id}:change-package', (ctx) => {
    const a = accountOf(ctx);
    if (isReply(a)) return a;
    const b = (ctx.body ?? {}) as {
      package_uuid?: string;
      version?: number | null;
      reason?: string;
    };
    const p = ctx.db.data.packages.find((x) => x.uuid === b.package_uuid);
    if (!p) return invalid('Chọn gói hosting.');
    const version = b.version ?? p.current_version;
    if (
      !ctx.db.data.package_versions.some((x) => x.package_uuid === p.uuid && x.version === version)
    ) {
      return invalid('Phiên bản gói không tồn tại.');
    }
    if (a.package.uuid === p.uuid && a.package.version === version) {
      return problem(409, 'conflict', 'Tài khoản đang dùng đúng gói và phiên bản này');
    }
    if (a.lifecycle_state !== 'active' && a.lifecycle_state !== 'suspended') {
      return problem(409, 'conflict', 'Không đổi gói được ở trạng thái hiện tại');
    }
    return startJob(ctx, {
      type: 'hosting_account.change_package',
      resource: resource(a),
      ops: ['quota.apply', 'php.pool.apply'],
      server: a.server,
      changes: {
        from: `${a.package.code} v${a.package.version}`,
        to: `${p.code} v${version}`,
        reason: b.reason ?? null,
      },
      onDone: (db) => {
        const lim =
          db.data.package_versions.find((x) => x.package_uuid === p.uuid && x.version === version)
            ?.limits ?? p.limits;
        a.package = { uuid: p.uuid, code: p.code, name: p.name, version };
        a.usage.disk_mb.limit = lim.disk_mb;
        a.usage.inodes.limit = lim.inode_limit;
        a.usage.cpu_percent.limit = lim.cpu_percent;
        a.usage.ram_mb.limit = lim.ram_mb;
        a.usage.websites.limit = lim.website_limit;
        a.usage.databases.limit = lim.database_limit;
        a.usage.ftp_accounts.limit = lim.ftp_limit;
        a.usage.cron_jobs.limit = lim.cron_limit;
        a.usage.backup_mb.limit = lim.backup_quota_mb;
        a.spec_version += 1;
        a.observed_version = a.spec_version;
        recount(db);
      },
    });
  });

  on('post', '/api/v1/admin/hosting-accounts/{id}:terminate', (ctx) => {
    const a = accountOf(ctx);
    if (isReply(a)) return a;
    const b = (ctx.body ?? {}) as { reason?: string; confirm_username?: string };
    if ((b.reason ?? '').trim().length < 5) return invalid('Lý do tối thiểu 5 ký tự.');
    if (b.confirm_username !== a.username) return invalid('Gõ đúng username để xác nhận.');
    if (a.lifecycle_state === 'terminated' || a.lifecycle_state === 'purged') {
      return problem(409, 'conflict', 'Tài khoản đã bị chấm dứt');
    }
    const keep =
      ctx.db.data.package_versions.find(
        (x) => x.package_uuid === a.package.uuid && x.version === a.package.version,
      )?.limits.retention_days_after_terminate ?? 30;
    return startJob(ctx, {
      type: 'hosting_account.terminate',
      resource: resource(a),
      ops: ['account.suspend', 'backup.run', 'backup.check'],
      server: a.server,
      changes: { reason: b.reason, keep_days: keep },
      onDone: (db) => {
        lifecycle(db, a, 'terminated', b.reason ?? null, ctx);
        a.terminated_at = db.now();
        a.purge_after = iso(Date.now() + keep * DAY);
        a.status = 'suspended';
        recount(db);
      },
    });
  });

  on('post', '/api/v1/admin/hosting-accounts/{id}:schedule-purge', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const a = accountOf(ctx);
    if (isReply(a)) return a;
    if (a.lifecycle_state !== 'terminated')
      return problem(409, 'conflict', 'Chỉ lên lịch purge cho tài khoản đã chấm dứt');
    if (a.legal_hold)
      return problem(
        409,
        'conflict',
        'Tài khoản đang bị giữ pháp lý (legal hold), không được purge',
      );
    const purges = ctx.db.data.purges;
    if (purges.some((p) => p.hosting_account.uuid === a.uuid && p.completed_at === null)) {
      return problem(409, 'conflict', 'Đã có yêu cầu purge cho tài khoản này');
    }
    const b = (ctx.body ?? {}) as { final_backup?: boolean; note?: string | null };
    const snap = ctx.db.data.snapshots.find(
      (s) => s.hosting_account?.uuid === a.uuid && s.verified_at,
    );
    const rec = {
      uuid: ctx.db.newUuid(),
      hosting_account: accRef(a),
      requested_by: actorRef(ctx),
      confirmed_by: null,
      final_backup_snapshot_uuid: snap?.uuid ?? null,
      backup_verified_at: snap?.verified_at ?? null,
      scheduled_for: a.purge_after ?? iso(Date.now() + 30 * DAY),
      completed_at: null,
      objects: [],
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    } as S['PurgeRecord'];
    purges.push(rec);
    return startJob(ctx, {
      type: 'hosting_account.schedule_purge',
      resource: resource(a),
      ops:
        b.final_backup === false
          ? ['backup.check']
          : ['backup.run', 'backup.check', 'backup.restore_test'],
      server: a.server,
      changes: { purge_uuid: rec.uuid, note: b.note ?? null },
      onDone: (db) => {
        rec.backup_verified_at = db.now();
        rec.final_backup_snapshot_uuid ??= db.data.snapshots[0]?.uuid ?? null;
        rec.updated_at = db.now();
      },
    });
  });

  on('post', '/api/v1/admin/hosting-accounts/{id}:confirm-purge', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const a = accountOf(ctx);
    if (isReply(a)) return a;
    const b = (ctx.body ?? {}) as { purge_uuid?: string; confirm_username?: string };
    const rec = ctx.db.data.purges.find(
      (p) => p.uuid === b.purge_uuid && p.hosting_account.uuid === a.uuid,
    );
    if (!rec) return problem(404, 'not_found', 'Không tìm thấy yêu cầu purge');
    if (b.confirm_username !== a.username) return invalid('Gõ đúng username để xác nhận.');
    if (rec.requested_by.uuid === ctx.actor.uuid) {
      return problem(
        403,
        'forbidden',
        'Người xác nhận purge phải là Super Admin khác người yêu cầu (D-46)',
      );
    }
    if (rec.confirmed_by) return problem(409, 'conflict', 'Yêu cầu purge đã được xác nhận');
    if (!rec.backup_verified_at)
      return problem(409, 'conflict', 'Chưa có bản sao lưu cuối đã kiểm chứng');
    if (a.legal_hold) return problem(409, 'conflict', 'Tài khoản đang bị giữ pháp lý (legal hold)');
    rec.confirmed_by = actorRef(ctx);
    rec.updated_at = ctx.db.now();
    // Xác nhận: kiểm tra lại backup ngay; purge tự chạy đúng hạn (scheduled_for).
    return startJob(ctx, {
      type: 'hosting_account.confirm_purge',
      resource: resource(a),
      ops: ['backup.check', 'backup.restore_test'],
      server: a.server,
      changes: { purge_uuid: rec.uuid, scheduled_for: rec.scheduled_for },
    });
  });

  // ---------------------------------------------------------------- chuyển server
  on('post', '/api/v1/admin/hosting-accounts/{id}:migrate', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const a = accountOf(ctx);
    if (isReply(a)) return a;
    const b = (ctx.body ?? {}) as {
      target_server_uuid?: string;
      strategy?: 'live_sync' | 'offline';
      keep_source_days?: number;
      dry_run?: boolean;
    };
    const target = ctx.db.data.servers.find((s) => s.uuid === b.target_server_uuid);
    if (!target) return invalid('Chọn máy chủ đích.');
    if (target.uuid === a.server.uuid) return invalid('Máy chủ đích phải khác máy chủ hiện tại.');
    if (!target.accepting_new_accounts)
      return problem(409, 'conflict', 'Máy chủ đích đang không nhận tài khoản mới');
    const keep = b.keep_source_days ?? 7;
    if (keep < 1 || keep > 30) return invalid('Giữ dữ liệu nguồn từ 1 đến 30 ngày.');
    if (a.lifecycle_state !== 'active' && a.lifecycle_state !== 'suspended') {
      return problem(409, 'conflict', 'Không chuyển được tài khoản ở trạng thái hiện tại');
    }
    const migs = ctx.db.data.migrations;
    if (
      migs.some(
        (m) =>
          m.hosting_account.uuid === a.uuid &&
          ['preflight', 'syncing', 'verifying', 'cutover'].includes(m.state),
      )
    ) {
      return problem(409, 'conflict', 'Tài khoản đang có lần chuyển server chưa xong');
    }
    if (b.dry_run) {
      return startJob(ctx, {
        type: 'hosting_account.migrate_preflight',
        resource: resource(a),
        ops: ['migrate.preflight'],
        server: a.server,
        changes: { target: target.name, dry_run: true },
      });
    }
    const m = {
      uuid: ctx.db.newUuid(),
      hosting_account: accRef(a),
      source_server: a.server,
      target_server: { uuid: target.uuid, name: target.name },
      state: 'preflight',
      bytes_synced: 0,
      downtime_sec: null,
      verification: {},
      job_uuid: null,
      requested_by: actorRef(ctx),
      cleanup_after: null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    } as S['AccountMigration'];
    migs.unshift(m);
    const prev = a.lifecycle_state;
    lifecycle(ctx.db, a, 'migrating', `Chuyển sang ${target.name}`, ctx);
    const r = startJob(ctx, {
      type: 'hosting_account.migrate',
      resource: resource(a),
      ops: ['migrate.preflight', 'migrate.sync', 'migrate.verify'],
      server: a.server,
      changes: {
        target: target.name,
        strategy: b.strategy ?? 'live_sync',
        keep_source_days: keep,
        migration: m.uuid,
      },
      onDone: (db) => {
        m.state = 'verifying';
        m.bytes_synced = a.usage.disk_mb.used * 1_048_576;
        m.verification = {
          files: { checked: a.usage.inodes.used, mismatched: 0 },
          databases: 'checksum khớp',
          ssl: 'đã sao chép',
          cron: `${a.usage.cron_jobs.used} job`,
          ownership: `đã chown theo UID ${a.uid}`,
        };
        m.updated_at = db.now();
        (m as unknown as { keep: number; prev: string }).keep = keep;
      },
    });
    m.job_uuid = (r.body as { job: { uuid: string } }).job.uuid;
    (m as unknown as { prev: string }).prev = prev;
    return r;
  });

  const migrationOf = (ctx: Ctx) => {
    const m = ctx.db.data.migrations.find((x) => x.uuid === ctx.params.id);
    const v = visibility(ctx.db, ctx.actor);
    return m && canSeeAccount(v, m.hosting_account.uuid)
      ? m
      : problem(404, 'not_found', 'Không tìm thấy lần chuyển server');
  };
  on('post', '/api/v1/admin/account-migrations/{id}:cutover', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const m = migrationOf(ctx);
    if (isReply(m)) return m;
    if (m.state !== 'verifying')
      return problem(409, 'conflict', 'Chỉ cutover sau khi kiểm tra dữ liệu xong');
    const a = ctx.db.data.accounts.find((x) => x.uuid === m.hosting_account.uuid);
    if (!a) return problem(404, 'not_found', 'Không tìm thấy tài khoản hosting');
    m.state = 'cutover';
    const keep = (m as unknown as { keep?: number }).keep ?? 7;
    const r = startJob(ctx, {
      type: 'hosting_account.migrate_cutover',
      resource: resource(a),
      ops: ['migrate.sync', 'migrate.cutover', 'migrate.verify'],
      server: m.target_server,
      onDone: (db) => {
        m.state = 'completed';
        m.downtime_sec = 42;
        m.cleanup_after = iso(Date.now() + keep * DAY);
        m.updated_at = db.now();
        a.server = m.target_server;
        for (const w of db.data.websites)
          if (w.hosting_account.uuid === a.uuid) w.server = m.target_server;
        for (const d of db.data.databases)
          if (d.hosting_account.uuid === a.uuid) d.server = m.target_server;
        lifecycle(
          db,
          a,
          (m as unknown as { prev?: Account['lifecycle_state'] }).prev ?? 'active',
          `Đã chuyển sang ${m.target_server.name}`,
          ctx,
        );
        recount(db);
      },
    });
    m.job_uuid = (r.body as { job: { uuid: string } }).job.uuid;
    return r;
  });
  on('post', '/api/v1/admin/account-migrations/{id}:rollback', (ctx) => {
    const deny = SA_ONLY(ctx);
    if (deny) return deny;
    const m = migrationOf(ctx);
    if (isReply(m)) return m;
    if (!['preflight', 'syncing', 'verifying', 'cutover', 'failed'].includes(m.state)) {
      return problem(409, 'conflict', 'Lần chuyển đã kết thúc, không hoàn tác được');
    }
    const a = ctx.db.data.accounts.find((x) => x.uuid === m.hosting_account.uuid);
    if (!a) return problem(404, 'not_found', 'Không tìm thấy tài khoản hosting');
    return startJob(ctx, {
      type: 'hosting_account.migrate_rollback',
      resource: resource(a),
      ops: ['migrate.rollback'],
      server: m.source_server,
      onDone: (db) => {
        m.state = 'rolled_back';
        m.updated_at = db.now();
        if (a.lifecycle_state === 'migrating') {
          lifecycle(
            db,
            a,
            (m as unknown as { prev?: Account['lifecycle_state'] }).prev ?? 'active',
            'Hoàn tác chuyển server',
            ctx,
          );
        }
      },
    });
  });

  // Vòng đời: sự kiện mẫu + sự kiện phát sinh trong demo (mới nhất trước).
  on('get', '/api/v1/admin/hosting-accounts/{id}/lifecycle-events', (ctx) => {
    const a = accountOf(ctx);
    if (isReply(a)) return a;
    const own = (ctx.db.data[`lifecycle@${a.uuid}`] ?? []) as S['LifecycleEvent'][];
    const base =
      a.created_at < '2026-11-20' ? (ctx.db.data.lifecycle as S['LifecycleEvent'][]) : [];
    return page(ctx, [...own, ...[...base].reverse()]);
  });
}
