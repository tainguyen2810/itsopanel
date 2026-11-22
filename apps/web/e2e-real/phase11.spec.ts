import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as httpServer, type Server as HttpServer } from 'node:http';
import { createServer as tcpServer, type Server as TcpServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  adminLogin,
  freshTotp,
  password,
  PORTAL_EMAIL,
  SUFFIX,
  watchServerErrors,
} from './helpers';

// Prompt 11.8: Monitoring, Alerts, Notifications trên stack thật + itso-agent --sandbox. Số liệu server/cgroup do
// sandbox sinh (cây cgroup giả trong gốc sandbox); file điều khiển metrics-control.json đẩy disk, giả lập mất kết nối,
// làm website down. Email tới SMTP giả (Node, 127.0.0.1), webhook tới HTTP giả trên IP mạng riêng.
//
// Webhook: SsrfGuard luôn chặn 127/8 và 192.0.2/24 (IP của container cloud), nên HTTP giả nghe ở một IP dải riêng
// (mặc định 10.99.0.1, đặt bằng ITSO_E2E_WEBHOOK_HOST) và kênh bật allow_private_network. Thêm IP đó vào lo trước
// khi chạy (Linux): `sudo ip addr add 10.99.0.1/32 dev lo` — xem docs/runbooks/phase-11-monitoring.md.
// Scheduler không chạy trong make dev: test gọi trực tiếp lệnh lịch (metrics-collect, alerts-evaluate, …).

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SBX = process.env.ITSO_SANDBOX_DIR ?? resolve(REPO, '.dev/agent-sandbox');
const FS_ROOT = resolve(SBX, 'root');
const ACCOUNT = 'anphat';
const HOOK_HOST = process.env.ITSO_E2E_WEBHOOK_HOST ?? '10.99.0.1';
const HOOK_PORT = 18_911;
const SMTP_PORT = 2525;
const HOOK_SECRET = `whsec-e2e-${SUFFIX}-0123456789abcdef`;
const DISK_RULE = 'Disk server > 90%';

type Realm = 'admin' | 'portal';
type Json = Record<string, unknown>;

function control(body: Json) {
  const p = resolve(FS_ROOT, 'var/lib/itso-sandbox/metrics-control.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body));
}

function artisan(...args: string[]) {
  return execFileSync('php', ['artisan', ...args, '--no-interaction'], {
    cwd: resolve(REPO, 'apps/api'),
    encoding: 'utf8',
    env: {
      ...process.env,
      ITSO_AGENT_SOCKET: process.env.ITSO_AGENT_SOCKET ?? resolve(SBX, 'agent.sock'),
      ITSO_AGENT_KEY_FILE: process.env.ITSO_AGENT_KEY_FILE ?? resolve(SBX, 'agent.key'),
    },
  });
}

/** metrics-collect trả mã lỗi khi mọi server mất kết nối — bước giả lập offline cần chạy tiếp. */
function collect() {
  try {
    artisan('itso:metrics-collect');
  } catch {
    /* agent "mất kết nối" (offline=true) */
  }
}

async function call(page: Page, realm: Realm, method: string, path: string, body?: unknown) {
  const xsrf = (await page.context().cookies()).find(
    (c) => c.name === `XSRF-TOKEN-${realm.toUpperCase()}`,
  )?.value;
  const res = await page.request.fetch(`/api/v1/${realm}${path}`, {
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

async function job(page: Page, r: { status: number; body: Json }) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const uuid = (r.body.job as { uuid: string }).uuid;
  await expect
    .poll(
      async () => data<{ state: string }>(await call(page, 'admin', 'GET', `/jobs/${uuid}`)).state,
      { timeout: 120_000 },
    )
    .toMatch(/^(succeeded|failed)$/);
  expect(data<{ state: string }>(await call(page, 'admin', 'GET', `/jobs/${uuid}`)).state).toBe(
    'succeeded',
  );
  return r.body;
}

async function stepUp(page: Page) {
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

async function account(page: Page) {
  const r = await call(page, 'admin', 'GET', '/hosting-accounts?per_page=100');
  return data<{ uuid: string; username: string; server: { uuid: string } }[]>(r).find(
    (x) => x.username === ACCOUNT,
  )!;
}

type Alert = {
  uuid: string;
  state: string;
  rule: { name: string };
  server: { uuid: string } | null;
  resource: { type: string; uuid: string };
};
async function alerts(page: Page, state: string) {
  return data<Alert[]>(
    await call(page, 'admin', 'GET', `/alerts?filter[state]=${state}&per_page=100`),
  );
}

// ---------- SMTP + webhook giả ----------

type Hook = { event: string; title: string; signatureOk: boolean; body: Json };
const hooks: Hook[] = [];
const mails: { to: string[]; data: string }[] = [];
let hookSrv: HttpServer | undefined;
let smtpSrv: TcpServer | undefined;

function startHook() {
  return new Promise<void>((ok, fail) => {
    hookSrv = httpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const ts = String(req.headers['x-itso-timestamp'] ?? '');
        const sig = String(req.headers['x-itso-signature'] ?? '');
        const want = `sha256=${createHmac('sha256', HOOK_SECRET).update(`${ts}.${body}`).digest('hex')}`;
        const json = JSON.parse(body) as Json;
        hooks.push({
          event: String(json.event),
          title: String(json.title),
          signatureOk: sig === want && Math.abs(Number(ts) - Date.now() / 1000) < 60,
          body: json,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    hookSrv.once('error', fail);
    hookSrv.listen(HOOK_PORT, HOOK_HOST, () => ok());
  });
}

/** SMTP tối thiểu (không TLS, không AUTH): đủ cho Symfony EsmtpTransport với encryption=none. */
function startSmtp() {
  return new Promise<void>((ok, fail) => {
    smtpSrv = tcpServer((sock) => {
      let buf = '';
      let inData = false;
      let to: string[] = [];
      let body = '';
      sock.write('220 itso-e2e ESMTP\r\n');
      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        for (;;) {
          if (inData) {
            const end = buf.indexOf('\r\n.\r\n');
            if (end < 0) return;
            body += buf.slice(0, end);
            buf = buf.slice(end + 5);
            inData = false;
            mails.push({ to, data: body });
            to = [];
            body = '';
            sock.write('250 OK queued\r\n');
            continue;
          }
          const nl = buf.indexOf('\r\n');
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO') sock.write('250-itso-e2e\r\n250 8BITMIME\r\n');
          else if (cmd === 'HELO') sock.write('250 itso-e2e\r\n');
          else if (cmd === 'RCPT') {
            to.push(line.replace(/^RCPT TO:\s*<?([^>]*)>?.*$/i, '$1'));
            sock.write('250 OK\r\n');
          } else if (cmd === 'DATA') {
            inData = true;
            sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (cmd === 'QUIT') {
            sock.end('221 Bye\r\n');
            return;
          } else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => undefined);
    });
    smtpSrv.once('error', fail);
    smtpSrv.listen(SMTP_PORT, '127.0.0.1', () => ok());
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  control({});
  // Đóng cảnh báo còn mở từ lần chạy trước (hysteresis 2 lượt) để luồng firing bắt đầu sạch.
  for (let i = 0; i < 2; i++) {
    collect();
    artisan('itso:alerts-evaluate');
  }
  await startHook();
  await startSmtp();
});

test.afterAll(async () => {
  control({});
  // Mẫu số liệu thật cuối cùng: spec sau (wizard tạo account) đọc disk còn trống từ mẫu mới nhất.
  collect();
  await new Promise((r) => hookSrv?.close(r));
  await new Promise((r) => smtpSrv?.close(r));
});

test('Số liệu server thật từ agent sandbox; usage account khớp cgroup', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const acct = await account(page);
  const srv = acct.server.uuid;

  collect();
  artisan('itso:usage-refresh');
  for (const metric of ['cpu_pct', 'ram_pct', 'disk_pct', 'load_1m']) {
    const s = data<{ points: unknown[]; source: string }>(
      await call(page, 'admin', 'GET', `/metrics/servers/${srv}?metric=${metric}&range=1h`),
    );
    expect(s.source).toBe('samples');
    expect(s.points.length, metric).toBeGreaterThan(0);
  }

  // RAM account = memory.current của slice itso-acct-<uid> (cây cgroup giả do sandbox sinh).
  const passwd = readFileSync(resolve(FS_ROOT, 'etc/passwd'), 'utf8');
  const uid = passwd
    .split('\n')
    .find((l) => l.startsWith(`${ACCOUNT}:`))!
    .split(':')[2];
  const mem = Number(
    readFileSync(
      resolve(
        FS_ROOT,
        `sys/fs/cgroup/itso.slice/itso-acct.slice/itso-acct-${uid}.slice/memory.current`,
      ),
      'utf8',
    ).trim(),
  );
  const rows = data<{ hosting_account: { username: string }; ram_mb: number; tasks: number }[]>(
    await call(page, 'admin', 'GET', `/metrics/servers/${srv}/accounts?q=${ACCOUNT}`),
  );
  const row = rows.find((r) => r.hosting_account.username === ACCOUNT);
  expect(row?.ram_mb).toBe(Math.floor(mem / 1024 / 1024));
  expect(row?.tasks).toBeGreaterThan(0);
  const series = data<{ points: unknown[] }>(
    await call(
      page,
      'admin',
      'GET',
      `/metrics/hosting-accounts/${acct.uuid}?metric=ram_pct&range=1h`,
    ),
  );
  expect(series.points.length).toBeGreaterThan(0);

  await page.goto('/admin/monitoring/accounts');
  await expect(page.getByText(ACCOUNT).first()).toBeVisible();
  await page.goto('/admin/monitoring');
  await expect(page.locator('svg').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Disk 92 % → firing → webhook ký đúng + email; về 80 % → resolved', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  await stepUp(page);
  const srv = (await account(page)).server.uuid;

  // SMTP giả + kênh email nhóm trực ca, kênh webhook (mạng riêng) — secret chỉ ghi.
  const smtp = await call(page, 'admin', 'PATCH', '/settings/smtp', {
    host: '127.0.0.1',
    port: SMTP_PORT,
    username: '',
    encryption: 'none',
    from: 'ITSO Panel <panel@itso.local>',
  });
  expect(smtp.status, JSON.stringify(smtp.body)).toBe(200);
  const email = await call(page, 'admin', 'POST', '/notification-channels', {
    type: 'email',
    name: `Trực ca ${SUFFIX}`,
    config: { recipients: [`oncall-${SUFFIX}@itso.local`] },
  });
  expect(email.status, JSON.stringify(email.body)).toBe(201);
  // SSRF: IP loopback bị từ chối ngay khi lưu.
  const loop = await call(page, 'admin', 'POST', '/notification-channels', {
    type: 'webhook',
    name: `Loopback ${SUFFIX}`,
    config: { url: 'http://127.0.0.1:8000/hook', allow_private_network: true },
    secret: HOOK_SECRET,
  });
  expect(loop.status).toBe(422);
  const hook = await call(page, 'admin', 'POST', '/notification-channels', {
    type: 'webhook',
    name: `Webhook ${SUFFIX}`,
    config: { url: `http://${HOOK_HOST}:${HOOK_PORT}/itso`, allow_private_network: true },
    secret: HOOK_SECRET,
  });
  expect(hook.status, JSON.stringify(hook.body)).toBe(201);
  const hookId = data<{ uuid: string }>(hook).uuid;
  expect(JSON.stringify(await call(page, 'admin', 'GET', '/notification-channels'))).not.toContain(
    HOOK_SECRET,
  );

  // Gửi thử webhook: đồng bộ, ký HMAC.
  const t = await call(page, 'admin', 'POST', `/notification-channels/${hookId}:test`);
  expect(data<{ state: string }>(t)?.state, JSON.stringify(t)).toBe('sent');
  expect(hooks.find((h) => h.event === 'channel.test')?.signatureOk).toBe(true);

  // Rule disk mặc định: thêm webhook vào kênh.
  const rules = data<{ uuid: string; name: string; channels: string[] }[]>(
    await call(page, 'admin', 'GET', '/alert-rules?per_page=100'),
  );
  const rule = rules.find((r) => r.name === DISK_RULE)!;
  const upd = await call(page, 'admin', 'PATCH', `/alert-rules/${rule.uuid}`, {
    channels: ['in_app', 'email', 'webhook'],
  });
  expect(upd.status, JSON.stringify(upd.body)).toBe(200);

  const t0 = Date.now();
  control({ disk_pct: 92 });
  const firing = async () =>
    (await alerts(page, 'firing')).some((a) => a.rule.name === DISK_RULE && a.server?.uuid === srv);
  // duration 60 giây: lượt đầu pending, lượt sau ≥ 60 giây thì firing.
  await expect
    .poll(
      async () => {
        collect();
        artisan('itso:alerts-evaluate');
        return firing();
      },
      { timeout: 150_000, intervals: [15_000] },
    )
    .toBe(true);
  expect(Date.now() - t0).toBeLessThan(120_000);

  // Queue notifications (worker của make dev) gửi webhook + email.
  // Kênh webhook của lần chạy trước (secret khác) có thể cũng nhận: lấy tin ký bằng secret của kênh này.
  const mine = () =>
    hooks.find((h) => h.event === 'alert.firing' && h.title.includes('Disk') && h.signatureOk);
  await expect.poll(mine, { timeout: 60_000 }).toBeTruthy();
  const fired = mine()!;
  expect(JSON.stringify(fired.body)).not.toContain(HOOK_SECRET);
  // Rule khác (vd. dịch vụ lõi dừng) cũng có thể gửi vào kênh email: lấy thư của cảnh báo disk.
  const diskMail = () =>
    mails.find((m) => m.to.includes(`oncall-${SUFFIX}@itso.local`) && /Disk srv/.test(m.data));
  await expect.poll(diskMail, { timeout: 60_000 }).toBeTruthy();
  // Link đầy đủ có tiền tố realm (kênh admin → /admin/…).
  expect(diskMail()!.data).toMatch(/\/admin\/monitoring\/alerts/);
  const dl = data<{ state: string; channel: { uuid: string }; event_type: string }[]>(
    await call(page, 'admin', 'GET', `/notification-deliveries?filter[channel]=${hookId}`),
  );
  expect(dl.some((d) => d.event_type === 'alert.firing' && d.state === 'sent')).toBe(true);

  await page.goto('/admin/monitoring/alerts');
  await expect(page.getByText(DISK_RULE).first()).toBeVisible();

  // Về 80 %: hysteresis 2 lượt đánh giá → resolved, webhook nhận alert.resolved.
  control({ disk_pct: 80 });
  for (let i = 0; i < 2; i++) {
    collect();
    artisan('itso:alerts-evaluate');
  }
  expect(await firing()).toBe(false);
  const resolved = await alerts(page, 'resolved');
  expect(resolved.some((a) => a.rule.name === DISK_RULE && a.server?.uuid === srv)).toBe(true);
  await expect
    .poll(
      () =>
        hooks.some(
          (h) => h.event === 'alert.resolved' && h.title.includes('Disk') && h.signatureOk,
        ),
      {
        timeout: 60_000,
      },
    )
    .toBe(true);
  control({});
  // Dọn kênh để lần chạy sau không gửi tới HTTP giả đã tắt.
  const emailId = data<{ uuid: string }>(email).uuid;
  for (const id of [hookId, emailId])
    expect((await call(page, 'admin', 'DELETE', `/notification-channels/${id}`)).status).toBe(204);
  expect(errors).toEqual([]);
});

test('Agent mất kết nối → cảnh báo firing ≤ 2 phút; nối lại → resolved', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const srv = (await account(page)).server.uuid;
  const rule = data<{ name: string; metric: string }[]>(
    await call(page, 'admin', 'GET', '/alert-rules?per_page=100'),
  ).find((r) => r.metric === 'agent_offline_sec')!;
  const offline = async () =>
    (await alerts(page, 'firing')).some((a) => a.rule.name === rule.name && a.server?.uuid === srv);

  collect();
  const t0 = Date.now();
  control({ offline: true });
  await expect
    .poll(
      async () => {
        collect();
        artisan('itso:alerts-evaluate');
        return offline();
      },
      { timeout: 150_000, intervals: [10_000] },
    )
    .toBe(true);
  const took = Date.now() - t0;
  expect(took).toBeLessThan(120_000);
  test.info().annotations.push({ type: 'offline_firing_ms', description: String(took) });

  control({});
  for (let i = 0; i < 2; i++) {
    collect();
    artisan('itso:alerts-evaluate');
  }
  expect(await offline()).toBe(false);
  expect(errors).toEqual([]);
});

test('Uptime: site sandbox down sau 3 lần lỗi → cảnh báo; lên lại → up', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const acct = await account(page);
  // Chạy lại trên cùng DB: dùng lại website up-* của lần trước (gói anphat giới hạn số website).
  type Check = { uuid: string; state: string; website: { uuid: string; primary_domain: string } };
  const checks = async () =>
    data<Check[]>(await call(page, 'admin', 'GET', '/uptime-checks?per_page=100'));
  let existing = (await checks()).find((x) =>
    /^up-[a-z]+\.anphat\.vn$/.test(x.website.primary_domain),
  );
  if (!existing) {
    const site = await job(
      page,
      await call(page, 'admin', 'POST', '/websites', {
        hosting_account_uuid: acct.uuid,
        primary_domain: `up-${SUFFIX}.anphat.vn`,
        type: 'static',
        ssl_mode: 'none',
      }),
    );
    const c = await call(page, 'admin', 'POST', '/uptime-checks', {
      website_uuid: (site.resource as { uuid: string }).uuid,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    existing = data<Check>(c);
  }
  const check = existing.uuid;
  const siteId = existing.website.uuid;
  const domain = existing.website.primary_domain;
  const state = async () =>
    data<{ uuid: string; state: string }[]>(
      await call(page, 'admin', 'GET', '/uptime-checks?per_page=100'),
    ).find((x) => x.uuid === check)?.state;

  artisan('itso:uptime-probe', '--all');
  expect(await state()).toBe('up');

  control({ uptime_down: [domain] });
  for (let i = 0; i < 3; i++) artisan('itso:uptime-probe', '--all');
  expect(await state()).toBe('down');
  artisan('itso:alerts-evaluate');
  const down = (await alerts(page, 'firing')).find(
    (a) => a.rule.name === 'Website không phản hồi' && a.resource.uuid === siteId,
  );
  expect(down, 'cảnh báo uptime').toBeTruthy();

  // USER chủ thấy site down trong Portal.
  const portal = await browser.newContext({ baseURL: test.info().project.use.baseURL ?? '' });
  const pp = await portal.newPage();
  await password(pp, 'portal', PORTAL_EMAIL);
  await expect(pp).toHaveURL(/\/portal\/(dashboard)?$/);
  const mine = data<{ uuid: string; username: string }[]>(
    await call(pp, 'portal', 'GET', '/hosting-accounts'),
  ).find((a) => a.username === ACCOUNT)!;
  const up = data<{ website: { primary_domain: string }; state: string }[]>(
    await call(pp, 'portal', 'GET', `/hosting-accounts/${mine.uuid}/uptime`),
  );
  expect(up.find((u) => u.website.primary_domain === domain)?.state).toBe('down');
  await portal.close();

  control({});
  artisan('itso:uptime-probe', '--all');
  expect(await state()).toBe('up');
  for (let i = 0; i < 2; i++) artisan('itso:alerts-evaluate');
  expect((await alerts(page, 'firing')).some((a) => a.uuid === down!.uuid)).toBe(false);
  expect(errors).toEqual([]);
});

test('USER thấy usage + uptime của mình, không thấy rule/kênh cảnh báo', async ({ page }) => {
  const errors = watchServerErrors(page);
  await password(page, 'portal', PORTAL_EMAIL);
  await expect(page).toHaveURL(/\/portal\/(dashboard)?$/);
  const mine = data<{ uuid: string; username: string }[]>(
    await call(page, 'portal', 'GET', '/hosting-accounts'),
  ).find((a) => a.username === ACCOUNT)!;
  const usage = await call(page, 'portal', 'GET', `/hosting-accounts/${mine.uuid}/usage`);
  expect(usage.status).toBe(200);
  const hist = await call(
    page,
    'portal',
    'GET',
    `/hosting-accounts/${mine.uuid}/usage-history?metric=ram_pct&range=1h`,
  );
  expect(hist.status, JSON.stringify(hist.body)).toBe(200);
  const up = await call(page, 'portal', 'GET', `/hosting-accounts/${mine.uuid}/uptime`);
  expect(up.status).toBe(200);
  const site = data<{ website: { primary_domain: string } }[]>(up)[0]?.website.primary_domain;
  expect(site, 'website có uptime check (luồng Uptime ở trên)').toBeTruthy();
  for (const path of [
    '/alert-rules',
    '/notification-channels',
    '/notification-deliveries',
    '/alerts',
  ])
    expect((await call(page, 'portal', 'GET', path)).status, path).toBe(404);
  for (const path of ['/alert-rules', '/notification-channels']) {
    const r = await page.request.get(`/api/v1/admin${path}`, {
      headers: { Accept: 'application/json' },
    });
    expect([401, 403]).toContain(r.status());
  }
  // Tùy chọn của USER: chỉ in-app + email.
  const ev = data<{ channels: string[] }[]>(
    await call(page, 'portal', 'GET', '/notification-events'),
  );
  expect([...new Set(ev.flatMap((e) => e.channels))].sort()).toEqual(['email', 'in_app']);

  await page.goto('/portal/monitoring');
  await page.getByRole('combobox', { name: 'Hosting account' }).click();
  await page.getByRole('option', { name: ACCOUNT, exact: true }).click();
  await expect(page.getByRole('img', { name: `Biểu đồ tài nguyên của ${ACCOUNT}` })).toBeVisible();
  await expect(page.getByText(site!).first()).toBeVisible();
  expect(errors).toEqual([]);
});
