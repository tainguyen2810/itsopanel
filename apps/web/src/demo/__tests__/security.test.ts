// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { leadingZeroBits, powValid, solvePow } from '@/shared/auth/pow';
import { loadRecording, screenAt, stripAnsi } from '@/entries/admin/security/TerminalSessionsPage';
import { resetDb, setStepMs } from '../db';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

// Prompt 7.0: hành vi demo cho mockup Phase 7 (CAPTCHA, SSH safe-apply, chống tự khóa, terminal, mã độc).
const BASE = 'http://demo.local';
const SA = '01938a01-0001-7000-8000-000001000001';
const MINH = '01938a01-0002-7000-8000-000001000002';
const ANPHAT_USER = '01938a01-0003-7000-8000-000001000003';
const SRV = '01938a02-0001-7000-8000-000002000001';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const F_LEHOA = '01938a32-0001-7000-8000-000032000001';
const F_ANPHAT = '01938a32-0002-7000-8000-000032000002';
const T_ROOT = '01938a31-0002-7000-8000-000031000002';
const T_USER = '01938a31-0001-7000-8000-000031000001';
const STEP = 10;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function call(
  method: string,
  url: string,
  body?: unknown,
  user = SA,
  realm: 'admin' | 'portal' = 'admin',
) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-User': user,
      'X-Demo-Realm': realm,
      'Idempotency-Key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = res.status === 204 ? undefined : await res.json();
  return { status: res.status, body: json };
}
const data = <T>(r: { body: unknown }) => (r.body as { data: T }).data;
const code = (r: { body: unknown }) => (r.body as { code?: string }).code;
const valid = (path: string, method: string, r: { status: number; body: unknown }) =>
  expect(validateResponse(path, method, r.status, r.body)).toEqual([]);
async function finish(r: { status: number; body: unknown }, user = SA) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const job = (r.body as { job: { uuid: string; steps: unknown[] } }).job;
  await wait(STEP * (job.steps.length + 3));
  const j = data<{ state: string }>(
    await call('GET', `/api/v1/admin/jobs/${job.uuid}`, undefined, user),
  );
  expect(j.state).toBe('succeeded');
}

beforeAll(() => {
  setStepMs(STEP);
  demoServer.listen({ onUnhandledFrame: 'error' });
});
beforeEach(() => resetDb());
afterAll(() => {
  demoServer.close();
  setStepMs(900);
});

describe('proof-of-work', () => {
  it('đếm bit 0 đầu', () => {
    expect(leadingZeroBits(new Uint8Array([0, 0x10, 0xff]))).toBe(11);
    expect(leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(leadingZeroBits(new Uint8Array([0, 0]))).toBe(16);
  });
  it('giải được và kiểm được; nonce sai bị từ chối', async () => {
    const nonce = await solvePow('v1.test', 8);
    expect(await powValid('v1.test', nonce, 8)).toBe(true);
    expect(await powValid('v1.other', 'abc', 1)).toBe(false);
  });
});

describe('CAPTCHA đăng nhập', () => {
  // Như API thật (7.4): CAPTCHA chỉ áp cho realm Portal.
  const login = (body: unknown) => call('POST', '/api/v1/auth/login', body, ANPHAT_USER, 'portal');
  it('đăng nhập Admin không cần CAPTCHA dù sai nhiều lần', async () => {
    const bad = { email: 'superadmin@itso.local', password: 'wrong-password' };
    for (let i = 0; i < 5; i++) await call('POST', '/api/v1/auth/login', bad);
    const r = await call('POST', '/api/v1/auth/login', { ...bad, password: 'demo-password' });
    expect(r.status).toBe(200);
  });
  it('sai quá ngưỡng thì cần CAPTCHA; lời giải đúng cho qua, dùng lại bị từ chối', async () => {
    const bad = { email: 'superadmin@itso.local', password: 'wrong-password' };
    for (let i = 0; i < 3; i++) {
      const r = await login(bad);
      expect(r.status).toBe(422);
      expect(code(r)).toBe('validation_failed');
    }
    const need = await login({ ...bad, password: 'demo-password' });
    expect(code(need)).toBe('captcha_required');
    valid('/api/v1/auth/login', 'post', need);
    const c = await call('GET', '/api/v1/auth/captcha');
    valid('/api/v1/auth/captcha', 'get', c);
    const ch = data<{ challenge: string; difficulty: number }>(c);
    const nonce = await solvePow(ch.challenge, ch.difficulty);
    const okr = await login({
      ...bad,
      password: 'demo-password',
      captcha: { challenge: ch.challenge, nonce },
    });
    expect(okr.status).toBe(200);
    // Đúng rồi thì bộ đếm về 0, không cần CAPTCHA nữa.
    expect((await login({ ...bad, password: 'demo-password' })).status).toBe(200);
  });
  it('thử thách dùng một lần', async () => {
    const bad = { email: 'x@itso.local', password: 'wrong-password' };
    for (let i = 0; i < 3; i++) await login(bad);
    const ch = data<{ challenge: string; difficulty: number }>(
      await call('GET', '/api/v1/auth/captcha'),
    );
    const nonce = await solvePow(ch.challenge, ch.difficulty);
    const sol = { challenge: ch.challenge, nonce };
    expect(code(await login({ ...bad, captcha: sol }))).toBe('validation_failed');
    expect(code(await login({ ...bad, password: 'ok', captcha: sol }))).toBe('captcha_required');
  });
});

describe('SSH safe-apply', () => {
  const base = '/api/v1/admin/security/ssh';
  const path = `${base}?server=${SRV}`;
  const confirm = `${base}:confirm?server=${SRV}`;
  it('bắt buộc ?server= như API thật', async () => {
    expect((await call('GET', base)).status).toBe(422);
    expect((await call('PATCH', base, { max_auth_tries: 4, rollback_after_sec: 60 })).status).toBe(
      422,
    );
    expect((await call('POST', `${base}:confirm`)).status).toBe(422);
    expect((await call('GET', `${base}?server=01938a02-0000-7000-8000-00000000dead`)).status).toBe(
      404,
    );
  });
  it('bắt buộc rollback_after_sec; xác nhận giữ cấu hình', async () => {
    const cur = data<{ updated_at: string }>(await call('GET', path));
    const etag = { 'If-Match': `"${cur.updated_at}"` };
    void etag;
    expect((await call('PATCH', path, { max_auth_tries: 4 })).status).toBe(422);
    await finish(await call('PATCH', path, { max_auth_tries: 4, rollback_after_sec: 60 }));
    expect(data<{ max_auth_tries: number }>(await call('GET', path)).max_auth_tries).toBe(4);
    expect((await call('PATCH', path, { max_auth_tries: 5, rollback_after_sec: 60 })).status).toBe(
      409,
    );
    const c = await call('POST', confirm);
    valid(`${base}:confirm`, 'post', c);
    await finish(c);
    expect((await call('POST', confirm)).status).toBe(409);
  });
  it('không xác nhận thì tự hoàn tác', async () => {
    await finish(await call('PATCH', path, { max_auth_tries: 6, rollback_after_sec: 30 }));
    const { db } = await import('../db');
    const st = db().data.ssh_state as { deadline: number };
    st.deadline = Date.now() - 1;
    await wait(1100);
    expect(data<{ max_auth_tries: number }>(await call('GET', path)).max_auth_tries).toBe(3);
  });
  it('tắt mật khẩu khi không có khóa quản trị → would_lock_out', async () => {
    const { db } = await import('../db');
    (db().data.ssh_settings as { admin_keys: number }).admin_keys = 0;
    const r = await call('PATCH', path, { password_authentication: false, rollback_after_sec: 60 });
    expect(code(r)).toBe('would_lock_out');
  });
});

describe('tường lửa chống tự khóa', () => {
  const url = `/api/v1/admin/servers/${SRV}/firewall/rules`;
  const rule = (b: object) => ({
    priority: 5,
    action: 'drop',
    direction: 'in',
    protocol: 'tcp',
    ports: '22',
    source: '0.0.0.0/0',
    enabled: true,
    ...b,
  });
  it('chặn SSH/panel từ IP hiện tại bị từ chối', async () => {
    expect(code(await call('POST', url, rule({})))).toBe('would_lock_out');
    expect(code(await call('POST', url, rule({ ports: '8000-9000' })))).toBe('would_lock_out');
    expect(code(await call('POST', url, rule({ source: '10.10.5.0/24', action: 'reject' })))).toBe(
      'would_lock_out',
    );
  });
  it('không chứa IP hiện tại, cổng khác, hoặc cho phép: được', async () => {
    expect((await call('POST', url, rule({ source: '203.0.113.0/24' }))).status).toBe(201);
    expect((await call('POST', url, rule({ priority: 6, ports: '3306' }))).status).toBe(201);
    expect((await call('POST', url, rule({ priority: 7, action: 'accept' }))).status).toBe(201);
  });
});

describe('terminal', () => {
  it('policy chỉ đọc; root bị từ chối khi policy tắt', async () => {
    const p = await call('GET', `/api/v1/admin/servers/${SRV}/terminal/policy`);
    valid('/api/v1/admin/servers/{id}/terminal/policy', 'get', p);
    expect(data<{ root_enabled: boolean }>(p).root_enabled).toBe(false);
    const r = await call('POST', '/api/v1/admin/terminal/sessions', {
      mode: 'root',
      server_uuid: SRV,
    });
    // Như API thật (7.5): agent op_disabled → 409 precondition_failed kèm lệnh CLI.
    expect(r.status).toBe(409);
    expect(code(r)).toBe('precondition_failed');
    valid('/api/v1/admin/terminal/sessions', 'post', r);
    // ADMIN thường: 403 kể cả khi policy bật.
    const { db } = await import('../db');
    (db().data.terminal_policy as { root_enabled: boolean }).root_enabled = true;
    const ad = await call(
      'POST',
      '/api/v1/admin/terminal/sessions',
      { mode: 'root', server_uuid: SRV },
      MINH,
    );
    expect(ad.status).toBe(403);
    expect(
      (await call('POST', '/api/v1/admin/terminal/sessions', { mode: 'root', server_uuid: SRV }))
        .status,
    ).toBe(201);
  });
  it('bản ghi đọc theo trang: next_offset nối tiếp, null ở trang cuối; offset sai 422', async () => {
    const url = `/api/v1/admin/terminal/sessions/${T_ROOT}/recording`;
    const pages = await loadRecording(async (offset) => {
      const r = await call('GET', `${url}?offset=${offset}`);
      valid('/api/v1/admin/terminal/sessions/{id}/recording', 'get', r);
      return data(r);
    });
    expect(pages.partial).toBe(false);
    expect(pages.events.length).toBe(8);
    expect(data<{ next_offset: number | null }>(await call('GET', url)).next_offset).toBe(4);
    expect((await call('GET', `${url}?offset=abc`)).status).toBe(422);
    expect((await call('GET', `${url}?offset=999`)).status).toBe(422);
  });
  it('mở phiên account được ghi vào danh sách phiên', async () => {
    const before = data<unknown[]>(await call('GET', '/api/v1/admin/terminal/sessions')).length;
    const t = await call('POST', '/api/v1/admin/terminal/sessions', {
      mode: 'account',
      hosting_account_uuid: ANPHAT,
    });
    expect(t.status).toBe(201);
    const list = await call('GET', '/api/v1/admin/terminal/sessions');
    valid('/api/v1/admin/terminal/sessions', 'get', list);
    expect(data<unknown[]>(list)).toHaveLength(before + 1);
  });
  it('bản ghi: chỉ SA, chỉ phiên được ghi', async () => {
    const ok = await call('GET', `/api/v1/admin/terminal/sessions/${T_ROOT}/recording`);
    valid('/api/v1/admin/terminal/sessions/{id}/recording', 'get', ok);
    expect((await call('GET', `/api/v1/admin/terminal/sessions/${T_USER}/recording`)).status).toBe(
      404,
    );
    expect(
      (await call('GET', `/api/v1/admin/terminal/sessions/${T_ROOT}/recording`, undefined, MINH))
        .status,
    ).toBe(403);
  });
  it('phát lại: bỏ ANSI, dựng màn hình theo thời điểm', () => {
    expect(stripAnsi('\u001b[1;32mok\u001b[0m\r\n')).toBe('ok\n');
    const ev = [
      { t: 0, data: '$ ' },
      { t: 1, data: 'ls\r\n' },
      { t: 2, data: 'a b\r\n' },
    ];
    expect(screenAt(ev, 1.5)).toBe('$ ls\n');
    expect(screenAt(ev, 9)).toBe('$ ls\na b\n');
  });
});

describe('fail2ban + tường lửa (7.6)', () => {
  it('IP bị chặn theo server; gỡ chặn qua job, giảm số đếm của jail', async () => {
    const list = await call('GET', `/api/v1/admin/security/fail2ban/bans?filter[server]=${SRV}`);
    valid('/api/v1/admin/security/fail2ban/bans', 'get', list);
    const rows = data<{ ip: string; jail: string; server: { uuid: string } }[]>(list);
    expect(rows.length).toBeGreaterThan(0);
    const b = rows[0]!;
    const r = await call('POST', '/api/v1/admin/security/fail2ban/bans:unban', {
      server: b.server.uuid,
      jail: b.jail,
      ip: b.ip,
    });
    valid('/api/v1/admin/security/fail2ban/bans:unban', 'post', r);
    await finish(r);
    const after = data<{ ip: string }[]>(
      await call('GET', `/api/v1/admin/security/fail2ban/bans?filter[server]=${SRV}`),
    );
    expect(after.some((x) => x.ip === b.ip)).toBe(false);
    expect(
      (
        await call('POST', '/api/v1/admin/security/fail2ban/bans:unban', {
          server: b.server.uuid,
          jail: b.jail,
          ip: b.ip,
        })
      ).status,
    ).toBe(404);
  });
  it('xem trước ruleset và trạng thái chờ xác nhận để nối lại đếm ngược', async () => {
    const pv = await call('GET', `/api/v1/admin/servers/${SRV}/firewall/preview`);
    valid('/api/v1/admin/servers/{id}/firewall/preview', 'get', pv);
    expect(data<{ ruleset: string }>(pv).ruleset).toContain('table inet itso');
    const idle = await call('GET', `/api/v1/admin/servers/${SRV}/firewall/status`);
    valid('/api/v1/admin/servers/{id}/firewall/status', 'get', idle);
    expect(data<{ state: string }>(idle).state).toBe('idle');
    await finish(
      await call('POST', `/api/v1/admin/servers/${SRV}/firewall:apply`, {
        rollback_after_sec: 120,
      }),
    );
    const st = data<{ state: string; rollback_at: string }>(
      await call('GET', `/api/v1/admin/servers/${SRV}/firewall/status`),
    );
    expect(st.state).toBe('pending_confirm');
    expect(Date.parse(st.rollback_at)).toBeGreaterThan(Date.now());
    expect(
      (await call('GET', `/api/v1/admin/servers/${SRV}/firewall/status`, undefined, MINH)).status,
    ).toBe(403);
  });
});

describe('mã độc', () => {
  it('Admin cách ly → khu cách ly có file', async () => {
    const before = data<unknown[]>(await call('GET', '/api/v1/admin/security/quarantine')).length;
    const list = await call('GET', '/api/v1/admin/security/malware/findings');
    valid('/api/v1/admin/security/malware/findings', 'get', list);
    await finish(
      await call('POST', `/api/v1/admin/security/malware/findings/${F_ANPHAT}:quarantine`),
    );
    expect(data<unknown[]>(await call('GET', '/api/v1/admin/security/quarantine'))).toHaveLength(
      before + 1,
    );
    expect(
      (await call('POST', `/api/v1/admin/security/malware/findings/${F_ANPHAT}:quarantine`)).status,
    ).toBe(409);
  });
  it('Portal chỉ thấy file của mình; file của account khác → 404', async () => {
    const r = await call(
      'GET',
      '/api/v1/portal/protection/findings',
      undefined,
      ANPHAT_USER,
      'portal',
    );
    valid('/api/v1/portal/protection/findings', 'get', r);
    expect(data<{ uuid: string }[]>(r).map((f) => f.uuid)).toEqual([F_ANPHAT]);
    const other = await call(
      'POST',
      `/api/v1/portal/protection/findings/${F_LEHOA}:quarantine`,
      undefined,
      ANPHAT_USER,
      'portal',
    );
    expect(other.status).toBe(404);
  });
  it('Portal: tổng quan, quét account, xóa file', async () => {
    const o = await call('GET', '/api/v1/portal/protection', undefined, ANPHAT_USER, 'portal');
    valid('/api/v1/portal/protection', 'get', o);
    expect(data<{ accounts: unknown[] }>(o).accounts.length).toBeGreaterThan(0);
    const s = await call(
      'POST',
      `/api/v1/portal/hosting-accounts/${ANPHAT}/scans`,
      undefined,
      ANPHAT_USER,
      'portal',
    );
    expect(s.status).toBe(202);
    const d = await call(
      'DELETE',
      `/api/v1/portal/protection/findings/${F_ANPHAT}`,
      undefined,
      ANPHAT_USER,
      'portal',
    );
    expect(d.status).toBe(202);
  });
});

describe('FIM + WAF theo website (7.6)', () => {
  it('thay đổi FIM theo file và sự kiện WAF của một website khớp hợp đồng', async () => {
    const f = await call('GET', '/api/v1/admin/security/fim/changes');
    valid('/api/v1/admin/security/fim/changes', 'get', f);
    expect(data<unknown[]>(f).length).toBeGreaterThan(0);
    const { db } = await import('../db');
    const ev = db().data.waf_events as { website: { uuid: string } }[];
    const site = ev[0]!.website.uuid;
    const w = await call('GET', `/api/v1/admin/websites/${site}/waf/events`);
    valid('/api/v1/admin/websites/{id}/waf/events', 'get', w);
    expect(data<{ website: { uuid: string } }[]>(w).every((e) => e.website.uuid === site)).toBe(
      true,
    );
  });
});
