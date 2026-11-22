import { ok, problem, on, type Ctx } from '../router';
import { canSeeAccount, canSeeServer, visibility } from '../scope';

const pct = (used: number, total: number) =>
  total > 0 ? Math.round((used * 1000) / total) / 10 : 0;

/**
 * Tổng hợp dashboard tính từ dữ liệu chi tiết theo phạm vi người xem, nên số trên dashboard
 * luôn bằng số dòng ở các trang danh sách (kể cả sau thao tác ghi trong phiên demo).
 */
export function dashboardOf(ctx: Ctx) {
  const db = ctx.db;
  const v = visibility(db, ctx.actor);
  const servers = db.data.servers.filter((s) => canSeeServer(v, s.uuid));
  const accounts = db.data.accounts.filter((a) => canSeeAccount(v, a.uuid));
  const live = accounts.filter(
    (a) => a.lifecycle_state !== 'terminated' && a.lifecycle_state !== 'purged',
  );
  const accSet = new Set(accounts.map((a) => a.uuid));
  const inScope = (r: { hosting_account?: { uuid: string } | null }) =>
    v.all || (r.hosting_account ? accSet.has(r.hosting_account.uuid) : false);
  const alerts = (db.data.alerts as { state: string }[]) ?? [];
  const overview = db.data.security_overview as { events_24h: Record<string, number> };
  return {
    counts: {
      servers: servers.length,
      hosting_accounts: live.length,
      websites: db.data.websites.filter(inScope).length,
      databases: db.data.databases.filter(inScope).length,
      users: v.all ? db.data.users.length : 1,
      packages: db.data.packages.length,
    },
    servers: servers.map((s) => ({
      server: { uuid: s.uuid, name: s.name },
      status: s.status,
      cpu_pct: s.resources.cpu_pct,
      ram_pct: pct(s.resources.ram_used_mb, s.resources.ram_mb),
      disk_pct: pct(s.resources.disk_used_mb, s.resources.disk_mb),
    })),
    package_distribution: db.data.packages.map((p) => ({
      code: p.code,
      accounts: live.filter((a) => a.package.uuid === p.uuid).length,
    })),
    alerts_firing: alerts.filter((a) => a.state === 'firing').length,
    security_events_24h: Object.values(overview.events_24h).reduce((a, b) => a + b, 0),
    jobs_running: db.data.jobs.filter((j) => j.state === 'running' || j.state === 'queued').length,
    updated_at: db.now(),
  };
}

// D-101: ≤ 24 giờ đọc samples 1 phút (gộp để vẽ), dài hơn đọc rollup 1 giờ.
const STEP: Record<string, number> = {
  '1h': 60,
  '24h': 1800,
  '7d': 10800,
  '30d': 43200,
  '90d': 129600,
};
const POINTS: Record<string, number> = { '1h': 60, '24h': 48, '7d': 56, '30d': 60, '90d': 60 };
const sourceOf = (range: string) => (range === '1h' || range === '24h' ? 'samples' : 'rollup');
const UNIT: Record<string, string> = {
  cpu_pct: 'pct',
  ram_pct: 'pct',
  disk_pct: 'pct',
  swap_pct: 'pct',
  inode_pct: 'pct',
  net_in: 'bps',
  net_out: 'bps',
  io_read: 'bps',
  io_write: 'bps',
  load_1m: 'count',
  tasks: 'count',
};

/** Số giả ngẫu nhiên ổn định theo seed (cùng tài nguyên + số liệu → cùng đường biểu đồ). */
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** Chuỗi số liệu: dao động quanh giá trị hiện tại, điểm cuối = giá trị hiện tại. */
export function series(seed: string, current: number, range: string, spread: number, max?: number) {
  const step = STEP[range] ?? 1800;
  const n = POINTS[range] ?? 48;
  const r = rng(seed + range);
  const now = Math.floor(Date.now() / 1000 / step) * step;
  const pts: [string, number][] = [];
  for (let i = n - 1; i >= 0; i--) {
    const daily = Math.sin(((now - i * step) / 86400) * 2 * Math.PI - Math.PI / 2);
    let val = i === 0 ? current : current * (1 + spread * (0.6 * daily + 0.8 * (r() - 0.5)));
    val = Math.max(0, max === undefined ? val : Math.min(max, val));
    const t = new Date((now - i * step) * 1000 + 7 * 3600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, '+07:00');
    pts.push([t, Math.round(val * 10) / 10]);
  }
  return { step_sec: step, points: pts };
}

const METRICS = Object.keys(UNIT);

export function registerDashboard() {
  on('get', '/api/v1/admin/dashboard/summary', (ctx) => ok(dashboardOf(ctx)));

  on('get', '/api/v1/admin/metrics/servers/{id}', (ctx) => {
    const s = ctx.db.data.servers.find((x) => x.uuid === ctx.params.id);
    if (!s || !canSeeServer(visibility(ctx.db, ctx.actor), s.uuid)) {
      return problem(404, 'not_found', 'Không tìm thấy server');
    }
    const metric = ctx.query.get('metric') ?? '';
    const range = ctx.query.get('range') ?? '24h';
    if (!METRICS.includes(metric) || !(range in STEP)) {
      return problem(422, 'validation_failed', 'metric hoặc range không hợp lệ');
    }
    const r = s.resources;
    // Băng thông (byte/giây): tỉ lệ theo số account trên server.
    const net = (s.account_count + 1) * 1_800_000;
    const base: Record<string, [number, number, number?]> = {
      cpu_pct: [r.cpu_pct, 0.35, 100],
      ram_pct: [pct(r.ram_used_mb, r.ram_mb), 0.08, 100],
      disk_pct: [pct(r.disk_used_mb, r.disk_mb), 0.01, 100],
      net_in: [net, 0.5],
      net_out: [net * 0.35, 0.6],
      load_1m: [r.load_1m, 0.4],
      swap_pct: [Math.min(100, r.cpu_pct / 6), 0.3, 100],
      inode_pct: [pct(r.disk_used_mb, r.disk_mb) * 0.55, 0.01, 100],
      io_read: [net * 0.6, 0.7],
      io_write: [net * 0.4, 0.7],
      tasks: [180 + s.account_count * 22, 0.15],
    };
    const [cur, spread, max] = base[metric] as [number, number, number?];
    // Server mất kết nối: không có điểm mới sau lúc mất heartbeat (biểu đồ dừng lại).
    const ser = series(`${s.uuid}:${metric}`, cur, range, spread, max);
    // Server mất kết nối: series dừng ở mẫu cuối (~20 phút trước), không vẽ tới hiện tại.
    if (s.status !== 'ready' && range === '1h') ser.points = ser.points.slice(0, 39);
    if (s.status !== 'ready' && range === '24h')
      ser.points = ser.points.slice(
        0,
        Math.max(1, ser.points.length - Math.ceil(ser.points.length / 24)),
      );
    return ok({
      resource: { type: 'server', uuid: s.uuid },
      metric,
      unit: UNIT[metric],
      source: sourceOf(range),
      limit: null,
      ...ser,
    });
  });

  const accountSeries = (ctx: Ctx) => {
    const a = ctx.db.data.accounts.find((x) => x.uuid === ctx.params.id);
    if (!a || !canSeeAccount(visibility(ctx.db, ctx.actor), a.uuid)) {
      return problem(404, 'not_found', 'Không tìm thấy account');
    }
    const metric = ctx.query.get('metric') ?? '';
    const range = ctx.query.get('range') ?? '24h';
    if (!METRICS.includes(metric) || !(range in STEP)) {
      return problem(422, 'validation_failed', 'metric hoặc range không hợp lệ');
    }
    const u = a.usage;
    const base: Record<string, [number, number, number?]> = {
      cpu_pct: [pct(u.cpu_percent.used, u.cpu_percent.limit ?? 100), 0.5, 100],
      ram_pct: [pct(u.ram_mb.used, u.ram_mb.limit ?? u.ram_mb.used * 2), 0.2, 100],
      disk_pct: [pct(u.disk_mb.used, u.disk_mb.limit ?? u.disk_mb.used * 2), 0.01, 100],
      inode_pct: [pct(u.inodes.used, u.inodes.limit ?? u.inodes.used * 2), 0.01, 100],
      swap_pct: [0, 0, 100],
      net_in: [200_000 + (u.disk_mb.used % 7) * 90_000, 0.6],
      net_out: [80_000 + (u.disk_mb.used % 5) * 40_000, 0.6],
      io_read: [20_000 + (u.disk_mb.used % 9) * 4000, 0.7],
      io_write: [8_000 + (u.disk_mb.used % 7) * 3000, 0.7],
      load_1m: [0.3, 0.5],
      tasks: [8 + (u.disk_mb.used % 11), 0.3],
    };
    const [cur, spread, max] = base[metric] as [number, number, number?];
    const unit = UNIT[metric] ?? 'count';
    return ok({
      resource: { type: 'hosting_account', uuid: a.uuid },
      metric,
      unit,
      source: sourceOf(range),
      // Số liệu % của account tính theo giới hạn gói: đường giới hạn ở 100 %.
      limit: unit === 'pct' ? 100 : null,
      ...series(`${a.uuid}:${metric}`, cur, range, spread, max),
    });
  };
  on('get', '/api/v1/admin/metrics/hosting-accounts/{id}', accountSeries);
  on('get', '/api/v1/portal/hosting-accounts/{id}/usage-history', accountSeries);
}
