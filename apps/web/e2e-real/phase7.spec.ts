import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  adminLogin,
  freshTotp,
  PASSWORD,
  PORTAL_EMAIL,
  SUFFIX,
  watchServerErrors,
} from './helpers';

// Prompt 7.7: Security Center trên stack thật + itso-agent --sandbox (nft/sshd/fail2ban/clamdscan mô phỏng ở tầng
// lệnh, file thật dưới gốc sandbox). Tường lửa áp dụng → xác nhận, không xác nhận → hoàn tác; SSH hardening;
// WAF bật + sự kiện; quét EICAR → cách ly → khôi phục; FIM; CAPTCHA Portal; terminal root bị từ chối khi policy tắt.
// Test ghi thẳng vào gốc sandbox (giả lập việc xảy ra trên máy chủ: gói ModSecurity có sẵn, file bị sửa, request
// tấn công vào log) rồi chạy lệnh lịch của Laravel thay cho scheduler (make dev không chạy schedule:work).

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SBX = process.env.ITSO_SANDBOX_DIR ?? resolve(REPO, '.dev/agent-sandbox');
const FS_ROOT = resolve(SBX, 'root');
const ACCOUNT = 'anphat';
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

type Realm = 'admin' | 'portal';
type Json = Record<string, unknown>;

/** Đường dẫn tuyệt đối trên "máy chủ" sandbox. */
const onServer = (p: string) => resolve(FS_ROOT, `.${p}`);

function put(p: string, content: string) {
  mkdirSync(dirname(onServer(p)), { recursive: true });
  writeFileSync(onServer(p), content);
}

/** Lệnh lịch của Laravel (scheduler không chạy trong make dev). */
function artisan(...args: string[]) {
  return execFileSync('php', ['artisan', ...args, '--no-interaction'], {
    cwd: resolve(REPO, 'apps/api'),
    encoding: 'utf8',
    // Cùng agent sandbox với make dev (scripts/dev.sh export hai biến này cho Laravel).
    env: {
      ...process.env,
      ITSO_AGENT_SOCKET: process.env.ITSO_AGENT_SOCKET ?? resolve(SBX, 'agent.sock'),
      ITSO_AGENT_KEY_FILE: process.env.ITSO_AGENT_KEY_FILE ?? resolve(SBX, 'agent.key'),
    },
  });
}

async function call(page: Page, realm: Realm, method: string, path: string, body?: unknown) {
  const xsrf = (await page.context().cookies()).find(
    (c) => c.name === `XSRF-TOKEN-${realm.toUpperCase()}`,
  )?.value;
  const res = await page.request.fetch(`/api/v1/${realm === 'admin' ? 'admin' : 'portal'}${path}`, {
    method,
    headers: {
      'Idempotency-Key': crypto.randomUUID(),
      'X-XSRF-TOKEN': decodeURIComponent(xsrf ?? ''),
      Accept: 'application/json',
    },
    ...(body === undefined ? {} : { data: body as Json }),
  });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : null) as Json };
}

const data = <T>(r: { body: Json }) => r.body.data as T;

/** 202 → chờ job tới trạng thái cuối mong muốn; job failed báo ngay kèm lỗi. */
async function job(page: Page, r: { status: number; body: Json }, want = 'succeeded') {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const uuid = (r.body.job as { uuid: string }).uuid;
  await expect
    .poll(
      async () => {
        const j = data<{ state: string; error?: unknown }>(
          await call(page, 'admin', 'GET', `/jobs/${uuid}`),
        );
        return j.state === 'failed' ? `failed ${JSON.stringify(j.error)}` : j.state;
      },
      { timeout: 60_000 },
    )
    .toMatch(new RegExp(`^(${want}|failed.*)$`));
  const j = data<{ state: string; error?: unknown }>(
    await call(page, 'admin', 'GET', `/jobs/${uuid}`),
  );
  expect(j.state, JSON.stringify(j.error)).toBe(want);
  return r.body;
}

async function serverUuid(page: Page) {
  const rows = data<{ uuid: string; name: string }[]>(await call(page, 'admin', 'GET', '/servers'));
  return (rows.find((x) => x.name === 'srv-local') ?? rows[0])!.uuid;
}

async function accountUuid(page: Page) {
  const r = await call(page, 'admin', 'GET', '/hosting-accounts?per_page=100');
  return data<{ uuid: string; username: string }[]>(r).find((x) => x.username === ACCOUNT)!.uuid;
}

/** Đăng nhập Admin rồi step-up MFA (mã TOTP chu kỳ mới; mã lúc đăng nhập không dùng lại được). */
async function adminStepUp(page: Page) {
  await adminLogin(page);
  const xsrf = (await page.context().cookies()).find((c) => c.name === 'XSRF-TOKEN-ADMIN')?.value;
  const r = await page.request.post('/api/v1/auth/step-up', {
    headers: {
      'X-ITSO-Realm': 'admin',
      'X-XSRF-TOKEN': decodeURIComponent(xsrf ?? ''),
      Accept: 'application/json',
    },
    data: { method: 'totp', code: await freshTotp(page) },
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

/** time_stamp của audit log ModSecurity: "Fri Nov 20 08:15:00 2026" (giờ máy chủ; máy dev/CI chạy UTC). */
function modsecTime(d: Date) {
  const [wd, , , , hms] = d.toUTCString().split(' ');
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${wd!.slice(0, 3)} ${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${hms} ${d.getUTCFullYear()}`;
}

test.describe.configure({ mode: 'serial' });

test('tường lửa: thêm rule → xem trước → áp dụng → giữ cấu hình; áp dụng không xác nhận → tự hoàn tác', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = watchServerErrors(page);
  await adminStepUp(page);
  const srv = await serverUuid(page);
  const port = String(20000 + Math.floor(Math.random() * 9999));
  // Rule cổng web để bản xem trước không cảnh báo website mất truy cập.
  const rules = data<{ ports: string | null }[]>(
    await call(page, 'admin', 'GET', `/servers/${srv}/firewall/rules`),
  );
  if (!rules.some((r) => r.ports === '80,443')) {
    const web = await call(page, 'admin', 'POST', `/servers/${srv}/firewall/rules`, {
      priority: 100,
      action: 'accept',
      direction: 'in',
      protocol: 'tcp',
      ports: '80,443',
      source: '0.0.0.0/0',
      comment: 'web',
    });
    expect(web.status, JSON.stringify(web.body)).toBe(201);
  }

  // UI: thêm rule → hộp áp dụng có ruleset xem trước chứa cổng mới → đếm ngược → giữ cấu hình.
  await page.goto(`/admin/servers/${srv}/firewall`);
  await page.getByRole('button', { name: 'Thêm rule' }).click();
  const form = page.getByRole('dialog', { name: 'Thêm rule tường lửa' });
  await form.getByLabel('Cổng').fill(port);
  await form.getByLabel('Nguồn').fill('10.20.0.0/16');
  await form.getByRole('button', { name: 'Lưu' }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: 'Áp dụng' }).click();
  const dlg = page.getByRole('dialog', { name: 'Áp dụng tường lửa an toàn' });
  await expect(dlg.getByTestId('firewall-preview')).toContainText(port, { timeout: 10_000 });
  await dlg.getByLabel('Tự hoàn tác sau (giây)').fill('120');
  await dlg.getByRole('button', { name: 'Áp dụng' }).click();
  await expect(page.getByTestId('firewall-countdown')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape'); // drawer job (nếu có) không che nút xác nhận
  await page.getByRole('button', { name: 'Giữ cấu hình mới' }).click();
  await expect(page.getByText('Đã xác nhận cấu hình tường lửa mới')).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(
      async () =>
        data<{ state: string }>(await call(page, 'admin', 'GET', `/servers/${srv}/firewall/status`))
          .state,
    )
    .toBe('confirmed');
  // Trạng thái safe-apply phía agent (nft -f qua stdin, sandbox không giữ ruleset): đã xác nhận.
  const agentState = () =>
    JSON.parse(readFileSync(onServer('/var/lib/itso/firewall/state.json'), 'utf8')) as {
      state: string;
    };
  expect(agentState().state).toBe('confirmed');

  // Áp dụng lần nữa (API) và KHÔNG xác nhận: hạn 30 giây + 15 giây ân hạn → rolled_back + sự kiện high.
  const extra = await call(page, 'admin', 'POST', `/servers/${srv}/firewall/rules`, {
    priority: 200,
    action: 'accept',
    direction: 'in',
    protocol: 'tcp',
    ports: String(Number(port) + 1),
    source: '10.30.0.0/16',
    comment: 'không xác nhận',
  });
  expect(extra.status).toBe(201);
  await job(
    page,
    await call(page, 'admin', 'POST', `/servers/${srv}/firewall:apply`, { rollback_after_sec: 30 }),
  );
  const st = data<{ state: string; rollback_at: string }>(
    await call(page, 'admin', 'GET', `/servers/${srv}/firewall/status`),
  );
  expect(st.state).toBe('pending_confirm');
  await expect
    .poll(
      async () =>
        data<{ state: string }>(await call(page, 'admin', 'GET', `/servers/${srv}/firewall/status`))
          .state,
      { timeout: 90_000, intervals: [5_000] },
    )
    .toBe('rolled_back');
  const late = await call(page, 'admin', 'POST', `/servers/${srv}/firewall:confirm`, {});
  expect(late.status).toBe(409);
  // Phía agent: timer systemd không có trong sandbox, agent vẫn chờ; op kế tiếp kiểm hạn và khôi phục cấu hình cũ
  // (hoàn tác thật bằng timer: tests/vm/phase7.sh S1). Bỏ rule thử rồi áp dụng + xác nhận cấu hình sạch.
  expect(agentState().state).toBe('pending_confirm');
  await call(
    page,
    'admin',
    'DELETE',
    `/servers/${srv}/firewall/rules/${(extra.body.data as { uuid: string }).uuid}`,
  );
  await job(
    page,
    await call(page, 'admin', 'POST', `/servers/${srv}/firewall:apply`, { rollback_after_sec: 30 }),
  );
  await job(page, await call(page, 'admin', 'POST', `/servers/${srv}/firewall:confirm`, {}));
  const ev = await call(page, 'admin', 'GET', '/security/events?filter[type]=firewall.rolled_back');
  expect(data<{ severity: string }[]>(ev)[0]?.severity).toBe('high');
  expect(errors).toEqual([]);
});

test('SSH hardening: đổi MaxAuthTries → chờ xác nhận → xác nhận; thiếu server 422', async ({
  page,
}) => {
  const errors = watchServerErrors(page);
  await adminStepUp(page);
  const srv = await serverUuid(page);
  expect((await call(page, 'admin', 'GET', '/security/ssh')).status).toBe(422);
  const cur = data<{ max_auth_tries: number }>(
    await call(page, 'admin', 'GET', `/security/ssh?server=${srv}`),
  );
  const want = cur.max_auth_tries === 3 ? 4 : 3;
  await job(
    page,
    await call(page, 'admin', 'PATCH', `/security/ssh?server=${srv}`, {
      max_auth_tries: want,
      rollback_after_sec: 120,
    }),
  );
  await job(page, await call(page, 'admin', 'POST', `/security/ssh:confirm?server=${srv}`, {}));
  expect(
    data<{ max_auth_tries: number }>(
      await call(page, 'admin', 'GET', `/security/ssh?server=${srv}`),
    ).max_auth_tries,
  ).toBe(want);

  // UI: trang SSH hiển thị giá trị mới.
  await page.goto('/admin/security/ssh');
  await expect(page.getByLabel('Số lần thử tối đa')).toHaveValue(String(want));
  expect(errors).toEqual([]);
});

test('WAF bật chặn + sự kiện; quét EICAR → cách ly → khôi phục', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchServerErrors(page);
  await adminStepUp(page);
  const acct = await accountUuid(page);
  const domain = `waf-${SUFFIX}.anphat.vn`;
  const created = await job(
    page,
    await call(page, 'admin', 'POST', '/websites', {
      hosting_account_uuid: acct,
      primary_domain: domain,
      type: 'static',
      ssl_mode: 'none',
    }),
  );
  const site = (created.resource as { uuid: string }).uuid;

  // Gói ModSecurity + CRS có sẵn trên máy (recipe modsecurity); thiếu thì agent báo available=false.
  put('/etc/modsecurity/crs/crs-setup.conf', '# crs\n');
  mkdirSync(onServer('/usr/share/modsecurity-crs/rules'), { recursive: true });
  put(
    '/etc/nginx/modules-enabled/50-mod-http-modsecurity.conf',
    'load_module modules/ngx_http_modsecurity_module.so;\n',
  );
  const waf0 = await call(page, 'admin', 'GET', `/websites/${site}/waf`);
  expect(data<{ mode: string }>(waf0).mode).toBe('detect'); // mặc định DetectionOnly
  await job(
    page,
    await call(page, 'admin', 'PATCH', `/websites/${site}/waf`, { enabled: true, mode: 'block' }),
  );
  expect(existsSync(onServer(`/etc/itso/waf/${site}.conf`))).toBe(true);

  // Request SQLi bị chặn (403) ghi vào audit log ModSecurity → lệnh đồng bộ → sự kiện của website.
  const line = JSON.stringify({
    transaction: {
      client_ip: '198.51.100.77',
      time_stamp: modsecTime(new Date()),
      server_id: 'x',
      client_port: 51234,
      host_ip: '10.0.0.1',
      host_port: 80,
      unique_id: SUFFIX,
      request: {
        method: 'GET',
        http_version: 1.1,
        uri: "/?id=1' OR 1=1--",
        headers: { Host: domain },
      },
      response: { http_code: 403, headers: {} },
      producer: {},
      messages: [
        { message: 'Inbound Anomaly Score Exceeded', details: { ruleId: '949110', severity: '2' } },
        {
          message: 'SQL Injection Attack Detected via libinjection',
          details: { ruleId: '942100', severity: '2' },
        },
      ],
    },
  });
  mkdirSync(dirname(onServer('/var/log/itso/waf/audit.log')), { recursive: true });
  appendFileSync(onServer('/var/log/itso/waf/audit.log'), `${line}\n`);
  artisan('itso:waf-events-sync');
  const events = data<{ rule_id: number; action: string; uri: string }[]>(
    await call(page, 'admin', 'GET', `/websites/${site}/waf/events`),
  );
  expect(events[0]).toMatchObject({ rule_id: 942100, action: 'blocked' });
  await page.goto(`/admin/websites/${site}?tab=waf`);
  await expect(page.getByRole('cell', { name: '942100' })).toBeVisible();

  // EICAR trong thư mục website → quét → finding → cách ly → khôi phục về chỗ cũ.
  const home = `/home/${ACCOUNT}`;
  const docroot = `${home}/sites/${domain}/public`;
  put(`${docroot}/eicar-${SUFFIX}.txt`, EICAR);
  await job(page, await call(page, 'admin', 'POST', `/websites/${site}/scans`, {}));
  const findings = data<
    { uuid: string; path: string; signature: string; engine: string; action: string }[]
  >(await call(page, 'admin', 'GET', `/security/malware/findings?q=eicar-${SUFFIX}`));
  const f = findings.find((x) => x.path.endsWith(`eicar-${SUFFIX}.txt`));
  expect(f, JSON.stringify(findings)).toBeTruthy();
  expect(f).toMatchObject({ engine: 'clamav', action: 'none' });
  expect(f!.signature).toMatch(/eicar/i);
  await job(
    page,
    await call(page, 'admin', 'POST', `/security/malware/findings/${f!.uuid}:quarantine`, {}),
  );
  expect(existsSync(onServer(`${docroot}/eicar-${SUFFIX}.txt`))).toBe(false);
  const q = data<{ uuid: string; original_path: string }[]>(
    await call(page, 'admin', 'GET', '/security/quarantine'),
  );
  const item = q.find((x) => x.original_path.endsWith(`eicar-${SUFFIX}.txt`));
  expect(item, JSON.stringify(q)).toBeTruthy();
  await job(
    page,
    await call(page, 'admin', 'POST', `/security/quarantine/${item!.uuid}:restore`, {}),
  );
  expect(existsSync(onServer(`${docroot}/eicar-${SUFFIX}.txt`))).toBe(true);
  rmSync(onServer(`${docroot}/eicar-${SUFFIX}.txt`));
  expect(errors).toEqual([]);
});

test('FIM: baseline → sửa file hệ thống → kiểm tra → thay đổi hiện trên trang FIM', async ({
  page,
}) => {
  const errors = watchServerErrors(page);
  await adminStepUp(page);
  const srv = await serverUuid(page);
  put('/etc/ssh/sshd_config.d/00-e2e.conf', '# e2e\n');
  await job(page, await call(page, 'admin', 'POST', `/servers/${srv}/fim:baseline`, {}));
  const target = `/usr/local/bin/e2e-${SUFFIX}`;
  put(target, '#!/bin/sh\necho backdoor\n');
  put('/etc/ssh/sshd_config.d/00-e2e.conf', '# e2e sửa\nPermitRootLogin yes\n');
  artisan('itso:fim-check');
  const changes = data<{ path: string; change: string }[]>(
    await call(page, 'admin', 'GET', `/security/fim/changes?filter[server]=${srv}&limit=200`),
  );
  expect(changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: target, change: 'added' }),
      expect.objectContaining({ path: '/etc/ssh/sshd_config.d/00-e2e.conf', change: 'modified' }),
    ]),
  );
  await page.goto('/admin/security/fim');
  await expect(page.getByRole('cell', { name: target })).toBeVisible();
  rmSync(onServer(target));
  rmSync(onServer('/etc/ssh/sshd_config.d/00-e2e.conf'));
  expect(errors).toEqual([]);
});

test('CAPTCHA Portal sau 3 lần sai; Admin không đòi CAPTCHA; terminal root bị từ chối khi policy tắt', async ({
  page,
}) => {
  const errors = watchServerErrors(page);
  // Portal: lấy cookie CSRF realm portal rồi đăng nhập sai 3 lần.
  await page.goto('/portal/login');
  await page.request.get('/api/v1/auth/csrf', { headers: { 'X-ITSO-Realm': 'portal' } });
  const login = async (body: Json) => {
    const xsrf = (await page.context().cookies()).find(
      (c) => c.name === 'XSRF-TOKEN-PORTAL',
    )?.value;
    const res = await page.request.post('/api/v1/auth/login', {
      headers: {
        'X-ITSO-Realm': 'portal',
        'X-XSRF-TOKEN': decodeURIComponent(xsrf ?? ''),
        Accept: 'application/json',
      },
      data: body,
    });
    return { status: res.status(), body: (await res.json()) as Json };
  };
  // Sai mật khẩu tới ngưỡng (mặc định 3; lượt sai cũ cùng IP trong 60 phút cũng tính) → 422 captcha_required,
  // kể cả khi mật khẩu đúng.
  const codes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await login({ email: PORTAL_EMAIL, password: 'sai-mat-khau' });
    codes.push(String(r.body.code));
    if (r.body.code === 'captcha_required') break;
  }
  // Sai mật khẩu: 422 validation_failed (thông báo chung cho email) cho tới khi chạm ngưỡng.
  expect(
    codes.every((c) => c === 'validation_failed' || c === 'captcha_required'),
    codes.join(','),
  ).toBe(true);
  const need = await login({ email: PORTAL_EMAIL, password: PASSWORD });
  expect(need.status).toBe(422);
  expect(need.body.code).toBe('captcha_required');
  const bad = await login({
    email: PORTAL_EMAIL,
    password: PASSWORD,
    captcha: { challenge: 'x.y', nonce: '1' },
  });
  expect(bad.body.code).toBe('captcha_required');
  // UI tự giải thử thách proof-of-work rồi đăng nhập (người dùng không phải làm gì thêm).
  await page.getByLabel('Email').fill(PORTAL_EMAIL);
  await page.getByLabel('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByTestId('captcha')).toHaveAttribute('data-state', 'solved', {
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL(/\/portal\/(dashboard)?$/, { timeout: 30_000 });

  // Admin đăng nhập bình thường; root terminal: policy sandbox tắt → 409 kèm hướng dẫn CLI.
  await adminStepUp(page);
  const srv = await serverUuid(page);
  const pol = data<{ root_enabled: boolean }>(
    await call(page, 'admin', 'GET', `/servers/${srv}/terminal/policy`),
  );
  expect(pol.root_enabled).toBe(false);
  const root = await call(page, 'admin', 'POST', '/terminal/sessions', {
    mode: 'root',
    server_uuid: srv,
  });
  expect(root.status, JSON.stringify(root.body)).toBe(409);
  expect(root.body.code).toBe('precondition_failed');
  expect(String(root.body.detail)).toContain('itso policy set');
  expect(errors).toEqual([]);
});
