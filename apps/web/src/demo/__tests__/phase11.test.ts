// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../dataset';
import { resetDb } from '../db';
import { webhookBlock } from '../handlers/monitoring';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

// Mockup 11.0: cảnh báo (default rule, ack/silence), uptime theo website, kênh + SSRF guard, phạm vi Portal.
const BASE = 'http://demo.local';
const SA = dataset.users.find((u) => u.role === 'SUPER_ADMIN')?.uuid ?? '';
const ADMIN = dataset.users.find((u) => u.role === 'ADMIN')?.uuid ?? '';
const ANPHAT_USER = '01938a01-0003-7000-8000-000001000003';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const MKT = '01938a05-0002-7000-8000-000005000002';

type Rule = { uuid: string; is_default?: boolean };
type Alert = { uuid: string; state: string; acknowledged_at?: string | null };
type Site = { uuid: string; hosting_account: { uuid: string } };
type Check = { uuid: string; website: { uuid: string } };
const rules = dataset.alert_rules as Rule[];
const alerts = dataset.alerts as Alert[];
const sites = dataset.websites as Site[];
const checks = dataset.uptime as Check[];
const siteOf = (acc: string) =>
  sites.find((w) => w.hosting_account.uuid === acc && checks.some((c) => c.website.uuid === w.uuid))
    ?.uuid ?? '';

async function call(method: string, url: string, body?: unknown, user = SA) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Demo-User': user },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = res.status === 204 ? undefined : await res.json();
  return { status: res.status, body: json };
}
const data = <T>(r: { body: unknown }) => (r.body as { data: T }).data;
const A = (p: string) => `/api/v1/admin${p}`;
const P = (p: string) => `/api/v1/portal${p}`;

beforeAll(() => demoServer.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => resetDb());
afterAll(() => demoServer.close());

describe('SSRF guard webhook (mô phỏng D-103)', () => {
  it('luôn chặn loopback và link-local, kể cả khi cho phép mạng riêng', () => {
    for (const url of [
      'https://127.0.0.1/hook',
      'https://localhost/hook',
      'http://[::1]/hook',
      'http://169.254.169.254/latest/meta-data',
      'http://0.0.0.0/',
    ])
      expect(webhookBlock(url, true), url).not.toBeNull();
  });
  it('mạng riêng chỉ được khi bật allow_private_network', () => {
    expect(webhookBlock('http://10.0.0.5/hook', false)).not.toBeNull();
    expect(webhookBlock('http://192.168.1.9/hook', false)).not.toBeNull();
    expect(webhookBlock('http://172.20.0.1/hook', false)).not.toBeNull();
    expect(webhookBlock('http://10.0.0.5/hook', true)).toBeNull();
    expect(webhookBlock('https://hooks.example.vn/x', false)).toBeNull();
  });
  it('API từ chối tạo webhook trỏ vào loopback hoặc http công khai', async () => {
    const base = { type: 'webhook', name: 'X', enabled: true, secret: 'a'.repeat(20) };
    const loop = await call('POST', A('/notification-channels'), {
      ...base,
      config: { url: 'https://127.0.0.1/x', allow_private_network: true },
    });
    expect(loop.status).toBe(422);
    const plain = await call('POST', A('/notification-channels'), {
      ...base,
      config: { url: 'http://hooks.example.vn/x', allow_private_network: false },
    });
    expect(plain.status).toBe(422);
  });
});

describe('kênh thông báo: secret chỉ ghi, chỉ SA', () => {
  it('tạo kênh không trả secret, chỉ secret_set', async () => {
    const r = await call('POST', A('/notification-channels'), {
      type: 'telegram',
      name: 'Ops Telegram mới',
      enabled: true,
      config: { chat_id: '-100123456' },
      secret: '123456:ABCDEFGHIJKLMNOP',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(JSON.stringify(r.body)).not.toContain('ABCDEFGHIJKLMNOP');
    expect(data<{ secret_set: boolean }>(r).secret_set).toBe(true);
    expect(validateResponse('/api/v1/admin/notification-channels', 'post', 201, r.body)).toEqual(
      [],
    );
  });
  it('ADMIN không quản lý kênh được', async () => {
    const r = await call(
      'POST',
      A('/notification-channels'),
      { type: 'email', name: 'X', enabled: true, config: { recipients: ['a@b.vn'] } },
      ADMIN,
    );
    expect(r.status).toBe(403);
  });
  it('gửi thử kênh ghi vào nhật ký gửi', async () => {
    const chs = data<{ uuid: string; type: string }[]>(
      await call('GET', A('/notification-channels')),
    );
    const ch = chs.find((c) => c.type === 'email');
    const r = await call('POST', A(`/notification-channels/${ch?.uuid}:test`));
    expect(r.status).toBe(200);
    const list = data<{ channel: { uuid: string } }[]>(
      await call('GET', A('/notification-deliveries')),
    );
    expect(list.some((d) => d.channel.uuid === ch?.uuid)).toBe(true);
  });
});

describe('quy tắc cảnh báo mặc định và thao tác cảnh báo (D-102)', () => {
  it('không xóa được quy tắc mặc định (409)', async () => {
    const def = rules.find((r) => r.is_default);
    expect(def).toBeDefined();
    const r = await call('DELETE', A(`/alert-rules/${def?.uuid}`));
    expect(r.status).toBe(409);
  });
  it('xác nhận rồi tắt tiếng một cảnh báo đang firing; xác nhận lần hai bị 409', async () => {
    const a = alerts.find((x) => x.state === 'firing' && !x.acknowledged_at);
    const ack = await call('POST', A(`/alerts/${a?.uuid}:ack`));
    expect(ack.status).toBe(200);
    expect(data<{ acknowledged_by: { uuid: string } }>(ack).acknowledged_by.uuid).toBe(SA);
    expect((await call('POST', A(`/alerts/${a?.uuid}:ack`))).status).toBe(409);
    const sil = await call('POST', A(`/alerts/${a?.uuid}:silence`), { duration_sec: 3600 });
    expect(sil.status).toBe(200);
    expect(data<{ silenced_until: string | null }>(sil).silenced_until).not.toBeNull();
    expect((await call('POST', A(`/alerts/${a?.uuid}:silence`), { duration_sec: 10 })).status).toBe(
      422,
    );
    expect((await call('POST', A(`/alerts/${a?.uuid}:unsilence`))).status).toBe(200);
  });
  it('xem trước quy tắc trả số tài nguyên khớp', async () => {
    const r = await call('POST', A('/alert-rules:preview'), {
      name: 'CPU',
      scope_type: 'server',
      metric: 'cpu_pct',
      operator: 'gt',
      threshold: 50,
      for_sec: 300,
      repeat_sec: 0,
      severity: 'high',
      channels: ['in_app'],
      enabled: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(typeof data<{ matches: number }>(r).matches).toBe('number');
  });
});

describe('uptime chỉ trên domain của website (D-105)', () => {
  it('từ chối đường dẫn là URL đầy đủ', async () => {
    const c = checks[0];
    const r = await call('PATCH', A(`/uptime-checks/${c?.uuid}`), {
      path: 'https://evil.example/',
    });
    expect(r.status).toBe(422);
  });
  it('USER chỉ xem/sửa uptime website của mình', async () => {
    const mine = siteOf(ANPHAT);
    const other = siteOf(MKT);
    expect(mine).not.toBe('');
    expect((await call('GET', P(`/websites/${mine}/uptime`), undefined, ANPHAT_USER)).status).toBe(
      200,
    );
    expect(
      (await call('PATCH', P(`/websites/${mine}/uptime`), { enabled: false }, ANPHAT_USER)).status,
    ).toBe(200);
    if (other)
      expect(
        (await call('GET', P(`/websites/${other}/uptime`), undefined, ANPHAT_USER)).status,
      ).toBe(404);
    expect(
      (await call('GET', P(`/hosting-accounts/${MKT}/uptime`), undefined, ANPHAT_USER)).status,
    ).toBe(404);
  });
  it('Portal: danh mục sự kiện chỉ của USER, kênh in_app và email', async () => {
    const ev = data<{ audiences: string[]; channels: string[] }[]>(
      await call('GET', P('/notification-events'), undefined, ANPHAT_USER),
    );
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => e.audiences.includes('user'))).toBe(true);
    expect(ev.every((e) => e.channels.every((c) => c === 'in_app' || c === 'email'))).toBe(true);
  });
});

describe('tùy chọn thông báo: kiểm như API (11.7)', () => {
  it('Portal không chọn được telegram hay sự kiện chỉ của admin; Admin không chọn webhook; critical luôn in-app', async () => {
    const tg = await call(
      'PATCH',
      P('/notification-preferences'),
      { events: { 'quota.warning': ['telegram'] } },
      ANPHAT_USER,
    );
    expect(tg.status).toBe(422);
    const adminOnly = await call(
      'PATCH',
      P('/notification-preferences'),
      { events: { 'security.high': ['in_app'] } },
      ANPHAT_USER,
    );
    expect(adminOnly.status).toBe(422);
    const okP = await call(
      'PATCH',
      P('/notification-preferences'),
      { events: { 'quota.warning': ['in_app', 'email'] } },
      ANPHAT_USER,
    );
    expect(okP.status, JSON.stringify(okP.body)).toBe(200);
    const hook = await call('PATCH', A('/notification-preferences'), {
      events: { 'alert.firing': ['webhook'] },
    });
    expect(hook.status).toBe(422);
    const locked = await call('PATCH', A('/notification-preferences'), {
      events: { 'security.high': ['email'] },
    });
    expect(locked.status).toBe(422);
    const ev = data<{ channels: string[] }[]>(await call('GET', A('/notification-events')));
    expect(ev.some((e) => e.channels.includes('webhook'))).toBe(false);
  });
  it('webhook IP viết thẳng bị chặn khi lưu, tên miền lưu được (chặn khi gửi như API)', async () => {
    const base = { type: 'webhook', enabled: true, secret: 'a'.repeat(20) };
    const meta = await call('POST', A('/notification-channels'), {
      ...base,
      name: 'Meta',
      config: { url: 'https://169.254.169.254/latest', allow_private_network: false },
    });
    expect(meta.status).toBe(422);
    const dns = await call('POST', A('/notification-channels'), {
      ...base,
      name: 'Tên miền',
      config: { url: 'https://hooks.example.vn/itso', allow_private_network: false },
    });
    expect(dns.status).toBe(201);
  });
});
