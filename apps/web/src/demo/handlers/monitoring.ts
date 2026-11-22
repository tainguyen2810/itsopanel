import type { components as A } from '@/api/generated/admin/schema';
import type { DemoDb } from '../db';
import { page } from '../list';
import { created, noContent, ok, on, problem, type Ctx, type Reply } from '../router';
import { canSeeAccount, canSeeServer, visibility } from '../scope';
import { actorRef } from './writes';

/**
 * Phase 11 (mockup 11.0): cảnh báo (ack/silence), uptime theo website, kênh thông báo + nhật ký gửi,
 * danh mục sự kiện, số liệu cgroup theo account. Hành vi mô phỏng theo D-102…D-105.
 */
type S = A['schemas'];
type Alert = S['Alert'];
type Uptime = S['UptimeCheck'];
type Channel = S['NotificationChannel'];
type Delivery = S['NotificationDelivery'];
type Website = S['Website'];

const P = (p: string) => `/api/v1/admin${p}` as Parameters<typeof on>[1];
const R = (p: string) => `/api/v1/portal${p}` as Parameters<typeof on>[1];
const invalid = (detail: string, field?: string): Reply => {
  const r = problem(422, 'validation_failed', 'Dữ liệu không hợp lệ', detail);
  return field ? { ...r, body: { ...(r.body as object), errors: { [field]: [detail] } } } : r;
};
const notFound = (what: string) => problem(404, 'not_found', `Không tìm thấy ${what}`);
const conflict = (detail: string) => problem(409, 'conflict', 'Xung đột trạng thái', detail);
const saOnly = (ctx: Ctx): Reply | null =>
  ctx.actor.role === 'SUPER_ADMIN'
    ? null
    : problem(403, 'forbidden', 'Chỉ Super Admin được thực hiện thao tác này');
const body = <T>(ctx: Ctx) => (ctx.body ?? {}) as Partial<T>;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

const alerts = (db: DemoDb) => db.data.alerts as Alert[];
const uptime = (db: DemoDb) => db.data.uptime as Uptime[];
const channels = (db: DemoDb) => db.data.notification_channels as Channel[];
const deliveries = (db: DemoDb) => db.data.notification_deliveries as Delivery[];
const websites = (db: DemoDb) => db.data.websites as unknown as Website[];

const plusSec = (iso: string, sec: number) =>
  new Date(new Date(iso).getTime() + sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------- uptime (D-105)
const PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/;

function uptimeError(b: Partial<S['UptimeCheckUpdate']>): Reply | null {
  if (b.path !== undefined && (!PATH_RE.test(b.path) || b.path.length > 200))
    return invalid(
      'Đường dẫn bắt đầu bằng / và thuộc chính website (không nhập URL khác).',
      'path',
    );
  if (
    b.interval_sec !== undefined &&
    (!Number.isInteger(b.interval_sec) || b.interval_sec < 60 || b.interval_sec > 3600)
  )
    return invalid('Chu kỳ kiểm từ 60 đến 3600 giây.', 'interval_sec');
  if (b.keyword !== undefined && b.keyword !== null && b.keyword.length > 100)
    return invalid('Từ khóa tối đa 100 ký tự.', 'keyword');
  return null;
}

function applyUptime(c: Uptime, b: Partial<S['UptimeCheckUpdate']>, now: string) {
  if (b.path !== undefined) {
    c.path = b.path;
    c.url = `https://${c.website.primary_domain}${b.path}`;
  }
  if (b.interval_sec !== undefined) c.interval_sec = b.interval_sec;
  if (has(b, 'keyword')) c.keyword = b.keyword ?? null;
  if (b.enabled !== undefined) {
    c.enabled = b.enabled;
    c.state = b.enabled
      ? c.last_status !== null && c.last_status < 400
        ? 'up'
        : 'unknown'
      : 'paused';
    if (b.enabled) c.last_checked_at = now;
  }
}

/** Kết quả kiểm gần đây: dữ liệu mẫu cho check đầu, còn lại sinh ổn định từ trạng thái. */
function resultsOf(db: DemoDb, c: Uptime): S['UptimeResult'][] {
  const base = db.data.uptime_results as S['UptimeResult'][];
  if (c.uuid === uptime(db)[0]?.uuid) return base;
  return base.map((r, k) => {
    const okRow = c.state === 'down' ? k > 3 : true;
    return {
      at: r.at,
      ok: okRow,
      status: okRow ? 200 : (c.last_status ?? null),
      latency_ms: okRow ? (c.last_latency_ms ?? 200) + ((k * 29) % 70) : null,
      error: okRow ? null : (c.last_error ?? 'Không phản hồi'),
    };
  });
}

function websiteFor(ctx: Ctx, id: string | undefined): Website | Reply {
  const w = websites(ctx.db).find((x) => x.uuid === id);
  if (!w || !canSeeAccount(visibility(ctx.db, ctx.actor), w.hosting_account.uuid))
    return notFound('website');
  return w;
}
const isReply = (x: unknown): x is Reply =>
  typeof x === 'object' && x !== null && 'status' in x && !('uuid' in x);

// ---------------------------------------------------------------- kênh thông báo (D-103)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** SSRF guard mô phỏng: loopback/link-local/metadata luôn chặn, mạng riêng chỉ khi bật. */
export function webhookBlock(url: string, allowPrivate: boolean): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'URL không hợp lệ.';
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /^127\./.test(host) || host === '::1' || host === '0.0.0.0')
    return `Địa chỉ ${host} là loopback, luôn bị chặn.`;
  if (/^169\.254\./.test(host) || /^fe80:/i.test(host))
    return `Địa chỉ ${host} thuộc dải link-local, luôn bị chặn.`;
  const priv =
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (priv && !allowPrivate)
    return `Địa chỉ ${host} thuộc mạng riêng; bật "Cho phép mạng riêng" nếu cố ý.`;
  return null;
}

function channelError(
  type: Channel['type'],
  cfg: Partial<S['NotificationChannelConfig']>,
  secret: string | null | undefined,
  creating: boolean,
): Reply | null {
  if (type === 'email') {
    const r = cfg.recipients ?? [];
    if (r.length === 0 || r.length > 20 || !r.every((e) => EMAIL_RE.test(e)))
      return invalid('Nhập 1 đến 20 địa chỉ email hợp lệ.', 'config.recipients');
  }
  if (type === 'telegram') {
    if (!cfg.chat_id || !/^-?[0-9]{1,20}$|^@[A-Za-z0-9_]{5,32}$/.test(cfg.chat_id))
      return invalid('Chat ID là số (nhóm bắt đầu bằng -100) hoặc @tên_kênh.', 'config.chat_id');
    if (creating && !secret) return invalid('Nhập bot token.', 'secret');
  }
  if (type === 'webhook') {
    const url = cfg.url ?? '';
    if (!/^https?:\/\//.test(url) || url.length > 500)
      return invalid('URL bắt đầu bằng https://.', 'config.url');
    if (url.startsWith('http://') && !cfg.allow_private_network)
      return invalid(
        'Chỉ dùng https://; http:// chỉ cho mạng riêng khi bật tùy chọn.',
        'config.url',
      );
    const block = webhookBlock(url, cfg.allow_private_network ?? false);
    if (block) return invalid(block, 'config.url');
    if (creating && !secret) return invalid('Nhập secret ký HMAC (tối thiểu 16 ký tự).', 'secret');
  }
  if (secret !== undefined && secret !== null && (secret.length < 16 || secret.length > 512))
    return invalid('Bí mật từ 16 đến 512 ký tự.', 'secret');
  return null;
}

function normalizeConfig(
  type: Channel['type'],
  cfg: Partial<S['NotificationChannelConfig']>,
): S['NotificationChannelConfig'] {
  return {
    recipients: type === 'email' ? (cfg.recipients ?? []) : [],
    chat_id: type === 'telegram' ? (cfg.chat_id ?? null) : null,
    url: type === 'webhook' ? (cfg.url ?? null) : null,
    allow_private_network: type === 'webhook' ? (cfg.allow_private_network ?? false) : false,
  };
}

function deliver(
  ctx: Ctx,
  c: Channel,
  event: string,
  title: string,
  severity: Delivery['severity'],
) {
  const now = ctx.db.now();
  const block =
    c.type === 'webhook'
      ? webhookBlock(c.config.url ?? '', c.config.allow_private_network ?? false)
      : null;
  const failing = c.type === 'webhook' && (c.config.url ?? '').includes('/hooks/k3x9w2');
  const d: Delivery = {
    uuid: ctx.db.newUuid(),
    channel: { uuid: c.uuid, name: c.name, type: c.type },
    event_type: event,
    title,
    severity,
    state: block ? 'blocked' : failing ? 'failed' : 'sent',
    attempts: block ? 0 : 1,
    error: block ?? (failing ? 'HTTP 500 Internal Server Error' : null),
    response_code: block ? null : failing ? 500 : c.type === 'email' ? 250 : 200,
    created_at: now,
    sent_at: block || failing ? null : now,
    next_retry_at: null,
  };
  deliveries(ctx.db).unshift(d);
  c.last_delivery = { state: d.state, at: d.sent_at ?? d.created_at, error: d.error };
  return d;
}

const toRef = (ctx: Ctx) => {
  const a = actorRef(ctx);
  return { uuid: a.uuid, name: a.name, email: a.email };
};

export function registerMonitoring() {
  // -- số liệu cgroup theo account trên server (D-101)
  on('get', P('/metrics/servers/{id}/accounts'), (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    const s = ctx.db.data.servers.find((x) => x.uuid === ctx.params.id);
    if (!s || !canSeeServer(v, s.uuid)) return notFound('server');
    const base = ctx.db.data.account_usage as S['AccountUsageRow'][];
    const rows = ctx.db.data.accounts
      .filter((a) => a.server.uuid === s.uuid && a.lifecycle_state === 'active')
      .filter((a) => canSeeAccount(v, a.uuid))
      .map((a): S['AccountUsageRow'] => {
        const known = base.find((r) => r.hosting_account.uuid === a.uuid);
        if (known) return known;
        const u = a.usage;
        return {
          hosting_account: { uuid: a.uuid, username: a.username },
          server: { uuid: s.uuid, name: s.name },
          cpu_pct: u.cpu_percent.used,
          ram_mb: u.ram_mb.used,
          ram_limit_mb: u.ram_mb.limit,
          io_read_bps: 20_000 + (u.disk_mb.used % 9) * 4000,
          io_write_bps: 8_000 + (u.disk_mb.used % 7) * 3000,
          tasks: 8 + (u.disk_mb.used % 11),
          disk_mb: u.disk_mb.used,
          disk_limit_mb: u.disk_mb.limit,
          sampled_at: '2026-11-20T08:15:00+07:00',
        };
      });
    return page(ctx, rows, { sort: '-cpu_pct', search: ['hosting_account.username'] });
  });

  // -- cảnh báo: ack, silence, unsilence (D-102)
  const findAlert = (ctx: Ctx): Alert | Reply =>
    alerts(ctx.db).find((a) => a.uuid === ctx.params.id) ?? notFound('cảnh báo');
  on('post', P('/alerts/{id}:ack'), (ctx) => {
    const a = findAlert(ctx);
    if (isReply(a)) return a;
    if (a.state !== 'firing') return conflict('Chỉ xác nhận được cảnh báo đang firing.');
    if (a.acknowledged_at) return conflict('Cảnh báo đã được xác nhận.');
    a.acknowledged_by = toRef(ctx);
    a.acknowledged_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'alert.ack',
      resource: { type: 'alert', uuid: a.uuid },
    });
    return ok(a);
  });
  on('post', P('/alerts/{id}:silence'), (ctx) => {
    const a = findAlert(ctx);
    if (isReply(a)) return a;
    if (a.state === 'resolved') return conflict('Cảnh báo đã kết thúc.');
    const b = body<S['AlertSilence']>(ctx);
    const sec = b.duration_sec;
    if (typeof sec !== 'number' || !Number.isInteger(sec) || sec < 300 || sec > 604800)
      return invalid('Thời gian tắt tạm từ 5 phút đến 7 ngày.', 'duration_sec');
    if (b.reason !== undefined && b.reason !== null && b.reason.length > 200)
      return invalid('Lý do tối đa 200 ký tự.', 'reason');
    a.silenced_until = plusSec(ctx.db.now(), sec);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'alert.silence',
      resource: { type: 'alert', uuid: a.uuid },
      changes: { duration_sec: sec, reason: b.reason ?? null },
    });
    return ok(a);
  });
  on('post', P('/alerts/{id}:unsilence'), (ctx) => {
    const a = findAlert(ctx);
    if (isReply(a)) return a;
    if (!a.silenced_until) return conflict('Cảnh báo không bị tắt tạm.');
    a.silenced_until = null;
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'alert.unsilence',
      resource: { type: 'alert', uuid: a.uuid },
    });
    return ok(a);
  });

  // -- uptime admin
  on('post', P('/uptime-checks'), (ctx) => {
    const b = body<S['UptimeCheckInput']>(ctx);
    const w = websiteFor(ctx, b.website_uuid);
    if (isReply(w)) return invalid('Chọn website trong phạm vi.', 'website_uuid');
    if (uptime(ctx.db).some((c) => c.website.uuid === w.uuid))
      return conflict('Website này đã có uptime check.');
    const err = uptimeError(b);
    if (err) return err;
    const path = b.path ?? '/';
    const c: Uptime = {
      uuid: ctx.db.newUuid(),
      website: { uuid: w.uuid, primary_domain: w.primary_domain },
      url: `https://${w.primary_domain}${path}`,
      interval_sec: b.interval_sec ?? 60,
      last_status: null,
      last_latency_ms: null,
      uptime_30d: 100,
      last_checked_at: null,
      enabled: b.enabled ?? true,
      path,
      keyword: b.keyword ?? null,
      state: (b.enabled ?? true) ? 'unknown' : 'paused',
      consecutive_failures: 0,
      last_error: null,
      uptime_24h: 100,
      uptime_7d: 100,
      cert_expires_at: w.certificate_expires_at ?? null,
      down_since: null,
    };
    uptime(ctx.db).push(c);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'uptime_check.create',
      resource: { type: 'website', uuid: w.uuid },
    });
    return created(c);
  });
  const adminUptime = (ctx: Ctx): Uptime | Reply => {
    const c = uptime(ctx.db).find((x) => x.uuid === ctx.params.id);
    if (!c) return notFound('uptime check');
    const w = websiteFor(ctx, c.website.uuid);
    return isReply(w) ? notFound('uptime check') : c;
  };
  on('patch', P('/uptime-checks/{id}'), (ctx) => {
    const c = adminUptime(ctx);
    if (isReply(c)) return c;
    const b = body<S['UptimeCheckUpdate']>(ctx);
    const err = uptimeError(b);
    if (err) return err;
    applyUptime(c, b, ctx.db.now());
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'uptime_check.update',
      resource: { type: 'website', uuid: c.website.uuid },
    });
    return ok(c);
  });
  on('delete', P('/uptime-checks/{id}'), (ctx) => {
    const c = adminUptime(ctx);
    if (isReply(c)) return c;
    const list = uptime(ctx.db);
    list.splice(list.indexOf(c), 1);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'uptime_check.delete',
      resource: { type: 'website', uuid: c.website.uuid },
    });
    return noContent();
  });
  on('get', P('/uptime-checks/{id}/results'), (ctx) => {
    const c = adminUptime(ctx);
    return isReply(c) ? c : page(ctx, resultsOf(ctx.db, c));
  });

  // -- uptime portal (chỉ website của mình)
  const portalUptime = (ctx: Ctx): Uptime | Reply => {
    const w = websiteFor(ctx, ctx.params.id);
    if (isReply(w)) return w;
    return uptime(ctx.db).find((c) => c.website.uuid === w.uuid) ?? notFound('uptime check');
  };
  on('get', R('/hosting-accounts/{id}/uptime'), (ctx) => {
    const v = visibility(ctx.db, ctx.actor);
    if (!canSeeAccount(v, ctx.params.id)) return notFound('account');
    const sites = new Set(
      websites(ctx.db)
        .filter((w) => w.hosting_account.uuid === ctx.params.id)
        .map((w) => w.uuid),
    );
    return page(
      ctx,
      uptime(ctx.db).filter((c) => sites.has(c.website.uuid)),
    );
  });
  on('get', R('/websites/{id}/uptime'), (ctx) => {
    const c = portalUptime(ctx);
    return isReply(c) ? c : ok(c);
  });
  on('patch', R('/websites/{id}/uptime'), (ctx) => {
    const c = portalUptime(ctx);
    if (isReply(c)) return c;
    const b = body<S['UptimeCheckUpdate']>(ctx);
    const err = uptimeError(b);
    if (err) return err;
    applyUptime(c, b, ctx.db.now());
    return ok(c);
  });
  on('get', R('/websites/{id}/uptime/results'), (ctx) => {
    const c = portalUptime(ctx);
    return isReply(c) ? c : page(ctx, resultsOf(ctx.db, c));
  });

  // -- kênh thông báo (SA)
  on('post', P('/notification-channels'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const b = body<S['NotificationChannelInput']>(ctx);
    if (!b.type || !['email', 'telegram', 'webhook'].includes(b.type))
      return invalid('Chọn loại kênh.', 'type');
    const name = b.name?.trim() ?? '';
    if (!name || name.length > 80) return invalid('Tên kênh từ 1 đến 80 ký tự.', 'name');
    if (channels(ctx.db).some((c) => c.name === name)) return conflict('Đã có kênh cùng tên.');
    const err = channelError(b.type, b.config ?? {}, b.secret, true);
    if (err) return err;
    const c: Channel = {
      uuid: ctx.db.newUuid(),
      type: b.type,
      name,
      enabled: b.enabled ?? true,
      config: normalizeConfig(b.type, b.config ?? {}),
      secret_set: Boolean(b.secret),
      last_delivery: null,
      created_at: ctx.db.now(),
      updated_at: ctx.db.now(),
    };
    channels(ctx.db).push(c);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'notification_channel.create',
      resource: { type: 'notification_channel', uuid: c.uuid },
      changes: { type: c.type, name: c.name, secret: b.secret ? '[đã che]' : null },
    });
    return created(c);
  });
  const findChannel = (ctx: Ctx): Channel | Reply =>
    channels(ctx.db).find((c) => c.uuid === ctx.params.id) ?? notFound('kênh thông báo');
  on('patch', P('/notification-channels/{id}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const c = findChannel(ctx);
    if (isReply(c)) return c;
    const b = body<S['NotificationChannelUpdate']>(ctx);
    if (b.name !== undefined && (!b.name.trim() || b.name.length > 80))
      return invalid('Tên kênh từ 1 đến 80 ký tự.', 'name');
    const cfg = b.config ? { ...c.config, ...b.config } : c.config;
    if (b.config || b.secret !== undefined) {
      const err = channelError(c.type, cfg, b.secret, false);
      if (err) return err;
    }
    if (b.name !== undefined) c.name = b.name.trim();
    if (b.enabled !== undefined) c.enabled = b.enabled;
    if (b.config) c.config = normalizeConfig(c.type, cfg);
    if (b.secret) c.secret_set = true;
    c.updated_at = ctx.db.now();
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'notification_channel.update',
      resource: { type: 'notification_channel', uuid: c.uuid },
      changes: {
        ...(b.secret ? { secret: '[đã che]' } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      },
    });
    return ok(c);
  });
  on('delete', P('/notification-channels/{id}'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const c = findChannel(ctx);
    if (isReply(c)) return c;
    const list = channels(ctx.db);
    list.splice(list.indexOf(c), 1);
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'notification_channel.delete',
      resource: { type: 'notification_channel', uuid: c.uuid },
    });
    return noContent();
  });
  on('post', P('/notification-channels/{id}:test'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const c = findChannel(ctx);
    if (isReply(c)) return c;
    return ok(deliver(ctx, c, 'channel.test', 'Tin thử từ ITSO Panel', 'info'));
  });
  on('post', P('/notification-deliveries/{id}:resend'), (ctx) => {
    const deny = saOnly(ctx);
    if (deny) return deny;
    const d = deliveries(ctx.db).find((x) => x.uuid === ctx.params.id);
    if (!d) return notFound('lượt gửi');
    if (d.state !== 'failed' && d.state !== 'blocked')
      return conflict('Chỉ gửi lại được lượt gửi lỗi hoặc bị chặn.');
    const c = channels(ctx.db).find((x) => x.uuid === d.channel.uuid);
    if (!c) return conflict('Kênh đã bị xóa.');
    return ok({ ...deliver(ctx, c, d.event_type, d.title, d.severity), state: 'queued' as const });
  });

  // -- danh mục sự kiện (cả hai realm; portal chỉ sự kiện của USER, kênh in_app + email)
  const events = (ctx: Ctx, portal: boolean) => {
    const all = ctx.db.data.notification_events as S['NotificationEvent'][];
    return portal
      ? all
          .filter((e) => e.audiences.includes('user'))
          .map((e) => ({
            ...e,
            channels: e.channels.filter((c) => c === 'in_app' || c === 'email'),
          }))
      : all;
  };
  on('get', P('/notification-events'), (ctx) => page(ctx, events(ctx, false)));
  on('get', R('/notification-events'), (ctx) => page(ctx, events(ctx, true)));
}
