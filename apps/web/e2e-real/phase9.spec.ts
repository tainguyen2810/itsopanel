import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { adminLogin, freshTotp, SUFFIX, watchServerErrors } from './helpers';

// Prompt 9.8: Multi-server trên stack thật (`make dev`: itso-relay + agent local sandbox). Test tự dựng một node MỚI:
// tạo token join trên UI → `itso --sandbox node rejoin` (ghim CA, CSR, enroll qua relay → panel ký bằng CA dev) →
// chạy `itso-agent --mode node` quay số ra relay → server online. Account trên node (website tĩnh + DB) → chuyển sang
// server local qua wizard → kiểm tra → cutover → site đọc từ đích; lượt khác hoàn tác; dừng node → job chờ node rồi chạy
// tiếp khi node quay lại; thu hồi node → relay từ chối, job tới node không chạy.
//
// Repo backup: đích local `/var/backups/itso`; gốc sandbox của node trỏ symlink sang gốc sandbox local để hai "máy"
// đọc chung repo (trên máy thật dùng SFTP/S3, preflight cảnh báo đích local).

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LOCAL_ROOT = resolve(
  process.env.ITSO_SANDBOX_DIR ?? resolve(REPO, '.dev/agent-sandbox'),
  'root',
);
const RELAY = resolve(REPO, '.dev/relay');
const NODE = resolve(REPO, `.dev/e2e-node-${SUFFIX}`);
const NODE_ROOT = resolve(NODE, 'root');
const NODE_NAME = `srv-node-${SUFFIX}`;
const OWNER = 'it@anphat.vn';
const UID_BASE = 30000 + (Math.floor(Date.now() / 1000) % 2000) * 10;

type Json = Record<string, unknown>;

const env = {
  ...process.env,
  ITSO_AGENT_SOCKET:
    process.env.ITSO_AGENT_SOCKET ?? resolve(REPO, '.dev/agent-sandbox/agent.sock'),
  ITSO_AGENT_KEY_FILE:
    process.env.ITSO_AGENT_KEY_FILE ?? resolve(REPO, '.dev/agent-sandbox/agent.key'),
  ITSO_RELAY_SOCKET: process.env.ITSO_RELAY_SOCKET ?? resolve(RELAY, 'relay.sock'),
  ITSO_PKI_CA_FILE: resolve(RELAY, 'ca.pem'),
};

function artisan(...args: string[]) {
  return execFileSync('php', ['artisan', ...args, '--no-interaction'], {
    cwd: resolve(REPO, 'apps/api'),
    encoding: 'utf8',
    env,
  });
}

let agent: ChildProcess | null = null;
function startNode() {
  writeFileSync(resolve(NODE, 'policy.yaml'), 'version: 1\n');
  agent = spawn(
    resolve(REPO, 'agent/bin/itso-agent'),
    [
      '--sandbox',
      '--mode',
      'node',
      '--root',
      NODE_ROOT,
      '--listen',
      `unix:${resolve(NODE, 'agent.sock')}`,
      '--key-file',
      resolve(NODE_ROOT, 'etc/itso/agent.key'),
      '--policy',
      resolve(NODE, 'policy.yaml'),
      '--audit-log',
      resolve(NODE, 'audit.jsonl'),
      '--allow-uid',
      String(process.getuid?.() ?? 0),
      '--stream-listen',
      '',
    ],
    { stdio: 'ignore' },
  );
}
function stopNode() {
  agent?.kill('SIGTERM');
  agent = null;
}

async function call(page: Page, method: string, path: string, body?: unknown) {
  const xsrf = (await page.context().cookies()).find((c) => c.name === 'XSRF-TOKEN-ADMIN')?.value;
  const res = await page.request.fetch(`/api/v1/admin${path}`, {
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

async function jobState(page: Page, uuid: string) {
  const j = data<{ state: string; error?: unknown }>(await call(page, 'GET', `/jobs/${uuid}`));
  return j.state === 'failed' ? `failed ${JSON.stringify(j.error)}` : j.state;
}
async function job(page: Page, r: { status: number; body: Json }) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const uuid = (r.body.job as { uuid: string }).uuid;
  await expect
    .poll(() => jobState(page, uuid), { timeout: 90_000 })
    .toMatch(/^(succeeded|failed.*)$/);
  expect(await jobState(page, uuid)).toBe('succeeded');
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

interface Server {
  uuid: string;
  name: string;
  connection: string;
}
const servers = async (page: Page) =>
  data<Server[]>(await call(page, 'GET', '/servers?per_page=100'));

/** Account trên node: website tĩnh (index có dấu) + DB MariaDB (sandbox). */
/** Kiểm tra trước qua API (cùng kết quả wizard hiện): báo rõ mục chặn nếu có. */
async function preflightOk(page: Page, account: string, target: string) {
  const r = await call(page, 'POST', `/hosting-accounts/${account}:migrate-preflight`, {
    target_server_uuid: target,
  });
  const d = data<{ ok: boolean; checks: { key: string; level: string; message: string }[] }>(r);
  expect(d.checks.filter((c) => c.level === 'block')).toEqual([]);
  expect(d.ok).toBe(true);
}

/**
 * Account trên node: site tĩnh (+ DB MariaDB nếu `withDb`). Trong sandbox node và server local dùng chung một
 * MariaDB, nên hoàn tác (xóa DB đã khôi phục ở đích) cũng xóa DB nguồn: account dùng cho lượt hoàn tác tạo không DB.
 */
async function accountOnNode(page: Page, node: Server, username: string, withDb = true) {
  const owner = data<{ uuid: string; email: string }[]>(
    await call(page, 'GET', `/users?per_page=100&q=${encodeURIComponent(OWNER)}`),
  ).find((u) => u.email === OWNER)!;
  const pkg = data<{ uuid: string }[]>(
    await call(page, 'GET', '/hosting-packages?per_page=10'),
  )[0]!;
  const acc = await job(
    page,
    await call(page, 'POST', '/hosting-accounts', {
      owner_user_uuid: owner.uuid,
      package_uuid: pkg.uuid,
      server_uuid: node.uuid,
      username,
      primary_domain: null,
    }),
  );
  const uuid = (acc.resource as { uuid: string }).uuid;
  const domain = `${username}.e2e.vn`;
  await job(
    page,
    await call(page, 'POST', '/websites', {
      hosting_account_uuid: uuid,
      primary_domain: domain,
      type: 'static',
      ssl_mode: 'none',
    }),
  );
  const index = resolve(NODE_ROOT, `home/${username}/sites/${domain}/public/index.html`);
  mkdirSync(dirname(index), { recursive: true });
  writeFileSync(index, `<h1>tu node ${SUFFIX}</h1>\n`);
  if (!withDb) return { uuid, domain };
  await job(
    page,
    await call(page, 'POST', '/databases', {
      hosting_account_uuid: uuid,
      engine: 'mariadb',
      name: `${username}_db`,
      create_user: false,
    }),
  );
  return { uuid, domain };
}

const st: { node?: Server; moved?: { uuid: string; domain: string; username: string } } = {};

test.describe.configure({ mode: 'serial' });

test.afterAll(() => {
  stopNode();
});

/** Toast "Đã xong" nằm đè nút ở góc; chuột đứng trên toast làm nó không tự tắt: dời chuột rồi chờ toast tắt. */
async function clearToasts(page: Page) {
  await page.mouse.move(5, 5);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 20_000 });
}

/** Thao tác 202 tự mở drawer theo dõi job (modal, che trang khỏi cây a11y): đợi drawer rồi đóng. */
async function closeJobDrawer(page: Page) {
  const drawer = page.getByRole('dialog', { name: 'Theo dõi tác vụ' });
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
}

test('thêm node: token trên UI → join qua relay (ghim CA) → agent node kết nối → online', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = watchServerErrors(page);
  rmSync(NODE, { recursive: true, force: true });
  mkdirSync(NODE_ROOT, { recursive: true });
  await adminLogin(page);
  await stepUp(page);

  await page.goto('/admin/servers/new');
  await page.getByLabel('Tên').fill(NODE_NAME);
  await page.getByRole('button', { name: 'Tạo token đăng ký' }).click();
  const cmd = page.getByText(/--token itso_enr_[\w-]+ --ca-sha256 [0-9a-f]{64}/);
  await expect(cmd).toBeVisible();
  const text = (await cmd.textContent()) ?? '';
  const token = /--token (itso_enr_[\w-]+)/.exec(text)![1]!;
  const pin = /--ca-sha256 ([0-9a-f]{64})/.exec(text)![1]!;
  const join = /--join (\S+)/.exec(text)![1]!;
  expect(join).toBe('https://127.0.0.1:28444');

  // Ghim sai CA → từ chối, không ghi gì.
  expect(() =>
    execFileSync(
      resolve(REPO, 'agent/bin/itso'),
      [
        '--sandbox',
        '--root',
        NODE_ROOT,
        'node',
        'rejoin',
        '--join',
        join,
        '--token',
        token,
        '--ca-sha256',
        '0'.repeat(64),
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    ),
  ).toThrow();
  expect(existsSync(resolve(NODE_ROOT, 'etc/itso/node/node.pem'))).toBe(false);

  const out = execFileSync(
    resolve(REPO, 'agent/bin/itso'),
    [
      '--sandbox',
      '--root',
      NODE_ROOT,
      'node',
      'rejoin',
      '--join',
      join,
      '--token',
      token,
      '--ca-sha256',
      pin,
    ],
    { encoding: 'utf8' },
  );
  expect(out).toContain('Đã join');
  await expect(page.getByText(`Máy chủ ${NODE_NAME} đã kết nối`)).toBeVisible({ timeout: 15_000 });
  // Token một lần: dùng lại → bị từ chối.
  expect(() =>
    execFileSync(
      resolve(REPO, 'agent/bin/itso'),
      [
        '--sandbox',
        '--root',
        resolve(NODE, 'again'),
        'node',
        'rejoin',
        '--join',
        join,
        '--token',
        token,
        '--ca-sha256',
        pin,
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    ),
  ).toThrow();

  startNode();
  await expect
    .poll(
      async () => {
        artisan('itso:relay-sync');
        return (await servers(page)).find((s) => s.name === NODE_NAME)?.connection;
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe('online');
  artisan('itso:metrics-collect');
  st.node = (await servers(page)).find((s) => s.name === NODE_NAME)!;
  await page.goto(`/admin/servers/${st.node.uuid}`);
  await page.getByRole('tab', { name: 'Agent' }).click();
  await expect(page.getByText('Kênh kết nối agent')).toBeVisible();
  await expect(page.getByText(/mTLS/).first()).toBeVisible();

  // UID trên node bắt đầu từ một mốc riêng của lần chạy (≥ 30000) để không trùng UID ở server local, kể cả user còn
  // lại trong gốc sandbox từ lần chạy trước (chuyển account cần cùng UID còn trống ở đích).
  artisan(
    'tinker',
    `--execute=DB::table('uid_allocations')->insert(['server_id' => App\\Models\\Server::query()->where('uuid', '${st.node.uuid}')->value('id'), 'uid' => ${UID_BASE}, 'allocated_at' => now(), 'released_at' => now()]);`,
  );
  // Hai "máy" đọc chung repo backup (xem đầu file).
  mkdirSync(resolve(LOCAL_ROOT, 'var/backups/itso'), { recursive: true });
  mkdirSync(resolve(NODE_ROOT, 'var/backups'), { recursive: true });
  symlinkSync(resolve(LOCAL_ROOT, 'var/backups/itso'), resolve(NODE_ROOT, 'var/backups/itso'));
  expect(errors).toEqual([]);
});

test('chuyển account từ node sang server local qua wizard: kiểm tra → cutover → site chạy ở đích', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = watchServerErrors(page);
  const node = st.node!;
  await adminLogin(page);
  await stepUp(page);
  // Đích backup local (nếu chưa có) cho repo của account.
  const dests = data<{ type: string }[]>(await call(page, 'GET', '/backup-destinations'));
  if (!dests.some((d) => d.type === 'local')) {
    const r = await call(page, 'POST', '/backup-destinations', {
      name: 'Ổ local',
      type: 'local',
      config: { path: '/var/backups/itso' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  }
  const username = `mv${SUFFIX}`;
  const { uuid, domain } = await accountOnNode(page, node, username);
  st.moved = { uuid, domain, username };

  artisan('itso:metrics-collect'); // heartbeat agent local (scheduler không chạy trong make dev)
  const local = (await servers(page)).find((s) => s.name === 'srv-local')!;
  await preflightOk(page, uuid, local.uuid);
  await page.goto(`/admin/hosting-accounts/${uuid}/migrate`);
  await page.getByRole('radio', { name: /srv-local/ }).check();
  await page.getByRole('button', { name: 'Kiểm tra trước' }).click();
  await expect(page.getByText(/Kết quả kiểm tra với srv-local/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Bắt đầu chuyển' }).click();
  await closeJobDrawer(page);
  await expect(page.getByRole('heading', { name: 'Kiểm tra dữ liệu' })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByText(/Dữ liệu trên srv-local đã được kiểm tra/)).toBeVisible();
  // Đang chuyển: account migrating, ghi dữ liệu bị chặn.
  const acc = data<{ lifecycle_state: string }>(
    await call(page, 'GET', `/hosting-accounts/${uuid}`),
  );
  expect(acc.lifecycle_state).toBe('migrating');
  const blocked = await call(page, 'POST', '/cron-jobs', {
    hosting_account_uuid: uuid,
    schedule: '0 3 * * *',
    command: 'true',
  });
  expect(blocked.status).toBe(409);

  await stepUp(page);
  await clearToasts(page);
  await page.getByRole('button', { name: 'Cutover' }).click();
  const dlg = page.getByRole('alertdialog', { name: /Cutover sang srv-local/ });
  await dlg.getByRole('textbox').fill(username);
  await dlg.getByRole('button', { name: 'Cutover' }).click();
  await closeJobDrawer(page);
  await expect(page.getByRole('heading', { name: 'Giữ nguồn' })).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('Account đang chạy ở srv-local')).toBeVisible();

  const after = data<{ lifecycle_state: string; server: { name: string } }>(
    await call(page, 'GET', `/hosting-accounts/${uuid}`),
  );
  expect(after.server.name).toBe('srv-local');
  expect(after.lifecycle_state).toBe('active');
  // Nội dung site ở đích = nội dung đã viết trên node.
  const index = resolve(LOCAL_ROOT, `home/${username}/sites/${domain}/public/index.html`);
  expect(readFileSync(index, 'utf8')).toBe(`<h1>tu node ${SUFFIX}</h1>\n`);
  // Nguồn bị khóa (bảo trì) chứ chưa xóa.
  expect(existsSync(resolve(NODE_ROOT, `home/${username}/sites/${domain}/public/index.html`))).toBe(
    true,
  );
  const migs = data<
    { hosting_account: { uuid: string }; state: string; downtime_sec: number | null }[]
  >(await call(page, 'GET', '/account-migrations'));
  const m = migs.find((x) => x.hosting_account.uuid === uuid)!;
  expect(m.state).toBe('holding');
  expect(m.downtime_sec).not.toBeNull();
  expect(errors).toEqual([]);
});

test('lượt khác: đồng bộ xong → hoàn tác → account vẫn ở node', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  await stepUp(page);
  const username = `rb${SUFFIX}`;
  const { uuid } = await accountOnNode(page, st.node!, username, false);
  artisan('itso:metrics-collect'); // heartbeat agent local (scheduler không chạy trong make dev)
  const local = (await servers(page)).find((s) => s.name === 'srv-local')!;
  await preflightOk(page, uuid, local.uuid);
  await page.goto(`/admin/hosting-accounts/${uuid}/migrate`);
  await page.getByRole('radio', { name: /srv-local/ }).check();
  await page.getByRole('button', { name: 'Kiểm tra trước' }).click();
  await expect(page.getByText(/Kết quả kiểm tra với srv-local/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Bắt đầu chuyển' }).click();
  await closeJobDrawer(page);
  await expect(page.getByRole('heading', { name: 'Kiểm tra dữ liệu' })).toBeVisible({
    timeout: 120_000,
  });
  await clearToasts(page);
  await page.getByRole('button', { name: 'Hoàn tác' }).click();
  await page
    .getByRole('alertdialog', { name: /Hoàn tác lần chuyển/ })
    .getByRole('button', { name: 'Hoàn tác' })
    .click();
  await closeJobDrawer(page);
  await expect(page.getByText('Lần chuyển đã kết thúc (rolled_back)')).toBeVisible({
    timeout: 60_000,
  });
  const a = data<{ lifecycle_state: string; server: { name: string } }>(
    await call(page, 'GET', `/hosting-accounts/${uuid}`),
  );
  expect(a.server.name).toBe(NODE_NAME);
  expect(a.lifecycle_state).toBe('active');
  expect(errors).toEqual([]);
});

test('node mất kết nối: job chờ node (waiting_agent) rồi chạy tiếp khi node quay lại; thu hồi → relay từ chối', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  await stepUp(page);
  const node = st.node!;
  stopNode();
  await page.waitForTimeout(1500);
  const r = await call(page, 'POST', `/servers/${node.uuid}/services/nginx:restart`, {});
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const uuid = (r.body.job as { uuid: string }).uuid;
  await expect.poll(() => jobState(page, uuid), { timeout: 30_000 }).toBe('waiting_agent');
  await page.goto('/admin/jobs?state=waiting_agent');
  await expect(
    page.getByRole('link', { name: /Khởi động lại dịch vụ|service/i }).first(),
  ).toBeVisible();

  startNode();
  await expect
    .poll(
      async () => {
        artisan('itso:relay-sync');
        return jobState(page, uuid);
      },
      { timeout: 60_000, intervals: [2000] },
    )
    .toBe('succeeded');

  // Còn account trên node → không thu hồi được (409). Chuyển nốt account còn lại sang local (qua API) rồi thu hồi.
  const blocked = await call(page, 'POST', `/servers/${node.uuid}:revoke`, {
    confirm_name: NODE_NAME,
  });
  expect(blocked.status).toBe(409);
  const rest = data<{ uuid: string; username: string; server: { uuid: string } }[]>(
    await call(page, 'GET', '/hosting-accounts?per_page=200'),
  ).filter((x) => x.server.uuid === node.uuid);
  const local = (await servers(page)).find((s) => s.name === 'srv-local')!;
  artisan('itso:metrics-collect');
  for (const x of rest) {
    await stepUp(page);
    await job(
      page,
      await call(page, 'POST', `/hosting-accounts/${x.uuid}:migrate`, {
        target_server_uuid: local.uuid,
      }),
    );
    const mig = async () =>
      data<{ uuid: string; state: string; hosting_account: { uuid: string } }[]>(
        await call(page, 'GET', '/account-migrations'),
      ).find(
        (m) =>
          m.hosting_account.uuid === x.uuid &&
          !['rolled_back', 'failed', 'completed'].includes(m.state),
      );
    await expect.poll(async () => (await mig())?.state, { timeout: 90_000 }).toBe('verifying');
    await job(page, await call(page, 'POST', `/account-migrations/${(await mig())!.uuid}:cutover`));
    await expect.poll(async () => (await mig())?.state, { timeout: 90_000 }).toBe('holding');
  }

  // Thu hồi node (SA + step-up, gõ tên) → relay đóng kết nối, job mới tới node không chạy.
  await stepUp(page);
  await page.goto(`/admin/servers/${node.uuid}`);
  await page.getByRole('button', { name: 'Thu hồi node' }).click();
  const dlg = page.getByRole('alertdialog', { name: new RegExp(`Thu hồi ${NODE_NAME}`) });
  await dlg.getByRole('textbox').fill(NODE_NAME);
  await dlg.getByRole('button', { name: 'Thu hồi node' }).click();
  await expect
    .poll(async () => (await servers(page)).find((s) => s.uuid === node.uuid)?.connection, {
      timeout: 30_000,
    })
    .toBe('revoked');
  artisan('itso:relay-sync');
  const after = await call(page, 'POST', `/servers/${node.uuid}/services/nginx:restart`, {});
  expect(after.status === 409 || after.status === 422 || after.status === 202).toBe(true);
  if (after.status === 202) {
    const id = (after.body.job as { uuid: string }).uuid;
    await expect.poll(() => jobState(page, id), { timeout: 30_000 }).toMatch(/^failed/);
  }
  expect(errors).toEqual([]);
});
