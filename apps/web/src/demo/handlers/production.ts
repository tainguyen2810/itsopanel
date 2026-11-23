import type { components as A } from '@/api/generated/admin/schema';
import type { DemoDb } from '../db';
import { page } from '../list';
import { noContent, ok, on, problem, type Ctx, type Reply } from '../router';
import { actorRef, startJob } from './writes';
import { needServer } from './security';

/**
 * Phase 12 (mockup 12.0): import từ panel khác (D-108), CIS chỉ đọc (D-109), sẵn sàng production + Gate (D-115).
 * Mọi màn hình chỉ SUPER_ADMIN, trừ CIS (theo phạm vi server như các trang Bảo mật khác).
 */
type S = A['schemas'];
type Import = S['Import'];
type Item = S['ImportItem'];
type Cis = S['CisReport'];

const P = (p: string) => `/api/v1/admin${p}` as Parameters<typeof on>[1];
const saOnly = (ctx: Ctx): Reply | null =>
  ctx.actor.role === 'SUPER_ADMIN'
    ? null
    : problem(403, 'forbidden', 'Chỉ Super Admin được thực hiện thao tác này');
const notFound = () => problem(404, 'not_found', 'Không tìm thấy lượt import');
const conflict = (detail: string) => problem(409, 'conflict', 'Xung đột trạng thái', detail);
const invalid = (errors: Record<string, string[]>): Reply => {
  const r = problem(
    422,
    'validation_failed',
    'Dữ liệu không hợp lệ',
    Object.values(errors)[0]?.[0],
  );
  return { ...r, body: { ...(r.body as object), errors } };
};

const imports = (db: DemoDb) => db.data.imports as Import[];
const items = (db: DemoDb) => db.data.import_items as Item[];
const itemsOf = (db: DemoDb, uuid: string) => items(db).filter((i) => i.import_uuid === uuid);
const BUSY = new Set<Import['state']>(['scanning', 'running']);
const USERNAME = /^[a-z][a-z0-9]{2,15}$/;

function summarize(db: DemoDb, imp: Import) {
  const list = itemsOf(db, imp.uuid);
  imp.summary = {
    sites: list.length,
    databases: list.reduce((n, i) => n + i.databases.length, 0),
    crons: list.reduce((n, i) => n + i.crons, 0),
    warnings: list.reduce((n, i) => n + i.warnings.length, 0),
    selected: list.filter((i) => i.selected).length,
  };
}

/** Kết quả quét giả lập: lấy các mục mẫu cùng nguồn trong bộ demo, đặt lại trạng thái chờ. */
function scanResult(db: DemoDb, imp: Import) {
  const template = imports(db).find(
    (x) => x.uuid !== imp.uuid && x.source === imp.source && itemsOf(db, x.uuid).length > 0,
  );
  if (!template) {
    imp.state = 'scan_failed';
    imp.error =
      imp.source === 'nginx'
        ? 'Không tìm thấy vhost nào có root/server_name trong /etc/nginx/sites-enabled'
        : 'Không tìm thấy cài đặt của panel nguồn trên máy chủ này';
    return;
  }
  for (const it of itemsOf(db, template.uuid)) {
    items(db).push({
      ...structuredClone(it),
      uuid: db.newUuid(),
      import_uuid: imp.uuid,
      state: it.selected ? 'pending' : 'skipped',
      progress: 0,
      result: null,
    });
  }
  imp.state = 'planned';
  imp.source_version = template.source_version;
  imp.error = null;
  summarize(db, imp);
}

export function registerProduction() {
  // ---------------------------------------------------------------- sẵn sàng production
  on('get', P('/system/readiness'), (ctx) => saOnly(ctx) ?? ok(ctx.db.data.readiness));

  // ---------------------------------------------------------------- import (D-108)
  on('get', P('/imports'), (ctx) => saOnly(ctx) ?? page(ctx, imports(ctx.db)));

  on('post', P('/imports'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const b = (ctx.body ?? {}) as Partial<S['ImportScanInput']>;
    const errors: Record<string, string[]> = {};
    if (!b.source || !['aapanel', 'hestia', 'nginx'].includes(b.source))
      errors.source = ['Chọn nguồn: aaPanel, HestiaCP hoặc Nginx thuần.'];
    const server = ctx.db.data.servers.find((s) => s.uuid === b.server);
    if (!server) errors.server = ['Chọn máy chủ.'];
    if (Object.keys(errors).length || !server || !b.source) return invalid(errors);
    if (!server.agent_connected)
      return conflict(`${server.name} đang mất kết nối, không quét được.`);
    if (imports(ctx.db).some((x) => x.server.uuid === server.uuid && BUSY.has(x.state)))
      return conflict(`Đang có lượt import khác chạy trên ${server.name}.`);
    const now = ctx.db.now();
    const imp: Import = {
      uuid: ctx.db.newUuid(),
      source: b.source,
      server: { uuid: server.uuid, name: server.name },
      state: 'scanning',
      source_version: null,
      scanned_at: null,
      error: null,
      summary: { sites: 0, databases: 0, crons: 0, warnings: 0, selected: 0 },
      cutover_at: null,
      created_by: actorRef(ctx),
      created_at: now,
      updated_at: now,
    };
    imports(ctx.db).unshift(imp);
    return startJob(ctx, {
      type: 'import.scan',
      resource: { type: 'import', uuid: imp.uuid },
      ops: ['import.scan'],
      server: imp.server,
      onDone: (db) => {
        imp.scanned_at = db.now();
        imp.updated_at = imp.scanned_at;
        scanResult(db, imp);
      },
    });
  });

  const find = (ctx: Ctx) => imports(ctx.db).find((x) => x.uuid === ctx.params.id);

  on('get', P('/imports/{id}'), (ctx) => saOnly(ctx) ?? (find(ctx) ? ok(find(ctx)) : notFound()));

  on('delete', P('/imports/{id}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const imp = find(ctx);
    if (!imp) return notFound();
    if (BUSY.has(imp.state)) return conflict('Lượt import đang chạy, chờ xong rồi xóa.');
    ctx.db.data.imports = imports(ctx.db).filter((x) => x !== imp);
    ctx.db.data.import_items = items(ctx.db).filter((i) => i.import_uuid !== imp.uuid);
    return noContent();
  });

  on('get', P('/imports/{id}/items'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const imp = find(ctx);
    return imp ? page(ctx, itemsOf(ctx.db, imp.uuid)) : notFound();
  });

  on('put', P('/imports/{id}/plan'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const imp = find(ctx);
    if (!imp) return notFound();
    if (imp.state !== 'planned')
      return conflict('Chỉ sửa kế hoạch khi lượt import ở trạng thái đã quét.');
    const input = ((ctx.body ?? {}) as Partial<S['ImportPlanInput']>).items ?? [];
    const own = itemsOf(ctx.db, imp.uuid);
    const errors: Record<string, string[]> = {};
    const taken = new Set(ctx.db.data.accounts.map((a) => a.username));
    const owners = new Map<string, string>();
    input.forEach((row, n) => {
      const it = own.find((x) => x.uuid === row.uuid);
      if (!it) {
        errors[`items.${n}.uuid`] = ['Mục không thuộc lượt import này.'];
        return;
      }
      if (!row.selected) return;
      if (it.warnings.some((w) => w.code === 'domain_exists'))
        errors[`items.${n}.selected`] = [`${it.domain} đã có trong ITSO; bỏ chọn mục này.`];
      const username = row.username ?? it.target.username;
      if (!USERNAME.test(username))
        errors[`items.${n}.username`] = ['Username 3–16 ký tự, bắt đầu bằng chữ thường.'];
      else if (taken.has(username))
        errors[`items.${n}.username`] = [`Username ${username} đã có account ITSO.`];
      const owner = row.user ?? row.new_user?.email ?? '';
      if (owners.has(username) && owners.get(username) !== owner)
        errors[`items.${n}.user`] = ['Các mục cùng username phải cùng chủ sở hữu.'];
      owners.set(username, owner);
      if (!row.user && !row.new_user)
        errors[`items.${n}.user`] = ['Chọn USER có sẵn hoặc tạo USER mới.'];
      if (row.package && !ctx.db.data.packages.some((p) => p.uuid === row.package))
        errors[`items.${n}.package`] = ['Gói không tồn tại.'];
    });
    if (Object.keys(errors).length) return invalid(errors);
    for (const row of input) {
      const it = own.find((x) => x.uuid === row.uuid);
      if (!it) continue;
      it.selected = row.selected;
      it.state = row.selected ? 'pending' : 'skipped';
      if (row.username) it.target.username = row.username;
      if (row.package) {
        const p = ctx.db.data.packages.find((x) => x.uuid === row.package);
        if (p)
          it.target.package = {
            uuid: p.uuid,
            code: p.code,
            name: p.name,
            version: p.current_version,
          };
      }
      if (row.user !== undefined) {
        const u = ctx.db.data.users.find((x) => x.uuid === row.user);
        it.target.user = u ? { uuid: u.uuid, name: u.name, email: u.email } : null;
      }
      if (row.new_user !== undefined) it.target.new_user = row.new_user;
    }
    imp.updated_at = ctx.db.now();
    summarize(ctx.db, imp);
    return ok(imp);
  });

  on('post', P('/imports/{id}:run'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const imp = find(ctx);
    if (!imp) return notFound();
    if (imp.state !== 'planned') return conflict('Chỉ chạy lượt import đã quét và lập kế hoạch.');
    const chosen = itemsOf(ctx.db, imp.uuid).filter((i) => i.selected);
    if (!chosen.length) return conflict('Chưa chọn mục nào để import.');
    imp.state = 'running';
    for (const it of chosen) it.state = 'running';
    return startJob(ctx, {
      type: 'import.run',
      resource: { type: 'import', uuid: imp.uuid },
      ops: [
        'account.ensure',
        'import.copy',
        'db.mysql.dump',
        'db.mysql.import',
        'nginx.vhost.apply',
        'cert.issue',
      ],
      server: imp.server,
      onDone: (db) => {
        for (const it of chosen) {
          it.state = 'done';
          it.progress = 100;
          it.result = {
            hosting_account: null,
            files: Math.round(it.size_mb * 11.3),
            bytes: it.size_mb * 1048576,
            skipped: 0,
            skipped_reasons: [],
            db_tables: it.databases.length * 24,
            db_rows_match: true,
            certificate: it.ssl === 'valid' ? 'reused' : 'acme',
            error: null,
          };
        }
        imp.state = 'completed';
        imp.updated_at = db.now();
      },
    });
  });

  for (const [action, from, to, op] of [
    ['cutover', ['completed', 'partially_failed'], 'cut_over', 'import.cutover'],
    ['rollback', ['cut_over'], 'rolled_back', 'import.rollback'],
  ] as const) {
    on('post', P(`/imports/{id}:${action}`), (ctx) => {
      const deny = saOnly(ctx);
      if (deny) return deny;
      const imp = find(ctx);
      if (!imp) return notFound();
      if (!(from as readonly string[]).includes(imp.state))
        return conflict(
          action === 'cutover'
            ? 'Chỉ cutover sau khi chạy import xong.'
            : 'Chỉ quay lại khi đã cutover.',
        );
      return startJob(ctx, {
        type: op,
        resource: { type: 'import', uuid: imp.uuid },
        ops: [op],
        server: imp.server,
        onDone: (db) => {
          imp.state = to;
          imp.cutover_at = to === 'cut_over' ? db.now() : imp.cutover_at;
          imp.updated_at = db.now();
        },
      });
    });
  }

  // ---------------------------------------------------------------- CIS (D-109)
  const reports = (db: DemoDb) => {
    const d = db.data as { cis_reports?: Record<string, Cis> };
    if (!d.cis_reports) {
      const base = db.data.cis_report as Cis;
      d.cis_reports = { [base.server.uuid]: base };
    }
    return d.cis_reports;
  };
  const serverOf = (ctx: Ctx) =>
    ctx.db.data.servers.find((s) => s.uuid === ctx.query.get('server'));

  on('get', P('/security/cis'), (ctx) => {
    const deny = needServer(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (!s) return problem(404, 'not_found', 'Không tìm thấy server');
    const r = reports(ctx.db)[s.uuid];
    return ok(
      r ?? {
        server: { uuid: s.uuid, name: s.name },
        profile: (ctx.db.data.cis_report as Cis).profile,
        audited_at: null,
        score: 0,
        passed: 0,
        failed: 0,
        not_applicable: 0,
        items: [],
      },
    );
  });

  on('post', P('/security/cis:audit'), (ctx) => {
    const deny = needServer(ctx);
    if (deny) return deny;
    const s = serverOf(ctx);
    if (!s) return problem(404, 'not_found', 'Không tìm thấy server');
    if (!s.agent_connected) return conflict(`${s.name} đang mất kết nối.`);
    return startJob(ctx, {
      type: 'cis.audit',
      resource: { type: 'server', uuid: s.uuid },
      ops: ['cis.audit'],
      server: { uuid: s.uuid, name: s.name },
      onDone: (db) => {
        const base = structuredClone(db.data.cis_report as Cis);
        reports(db)[s.uuid] = {
          ...base,
          server: { uuid: s.uuid, name: s.name },
          audited_at: db.now(),
        };
      },
    });
  });
}
