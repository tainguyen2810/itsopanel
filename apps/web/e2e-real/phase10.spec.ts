import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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

// Prompt 10.8: Software, Docker, WordPress trên stack thật + itso-agent --sandbox (Engine Docker giả, WP-CLI mô phỏng
// trên file thật + restic THẬT cho snapshot pre-wp-update). Lỗi giả lập (image mới unhealthy, plugin update lỗi) bật
// qua file điều khiển dưới gốc sandbox — chỉ sandbox đọc (agent thật không có đường tới).

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SBX = process.env.ITSO_SANDBOX_DIR ?? resolve(REPO, '.dev/agent-sandbox');
const FS_ROOT = resolve(SBX, 'root');
const ACCOUNT = 'anphat';

type Realm = 'admin' | 'portal';
type Json = Record<string, unknown>;

function control(name: 'wp-control.json' | 'docker-control.json', body: Json) {
  const p = resolve(FS_ROOT, 'var/lib/itso-sandbox', name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(body));
}

/** Lệnh lịch của Laravel (scheduler không chạy trong make dev). */
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

async function job(page: Page, realm: Realm, r: { status: number; body: Json }) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const uuid = (r.body.job as { uuid: string }).uuid;
  const state = async () => {
    const j = data<{ state: string; error?: unknown }>(
      await call(page, realm, 'GET', `/jobs/${uuid}`),
    );
    return j.state === 'failed' ? `failed ${JSON.stringify(j.error)}` : j.state;
  };
  await expect.poll(state, { timeout: 120_000 }).toMatch(/^(succeeded|failed.*)$/);
  expect(await state()).toBe('succeeded');
  return r.body;
}

/** Gửi lại khi tài nguyên đang có tác vụ khác (409 resource_locked), tối đa ~60 giây. */
async function whenIdle(page: Page, realm: Realm, method: string, path: string, body?: unknown) {
  for (let i = 0; ; i++) {
    const r = await call(page, realm, method, path, body);
    if (r.status !== 409 || (r.body as { code?: string }).code !== 'resource_locked' || i >= 30)
      return r;
    await page.waitForTimeout(2000);
  }
}

async function stepUp(page: Page, realm: Realm, code: string) {
  const xsrf = (await page.context().cookies()).find(
    (c) => c.name === `XSRF-TOKEN-${realm.toUpperCase()}`,
  )?.value;
  const r = await page.request.post('/api/v1/auth/step-up', {
    headers: {
      'X-ITSO-Realm': realm,
      'X-XSRF-TOKEN': decodeURIComponent(xsrf ?? ''),
      Accept: 'application/json',
    },
    data: { method: 'totp', code },
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

async function account(page: Page) {
  const r = await call(page, 'admin', 'GET', '/hosting-accounts?per_page=100');
  return data<{ uuid: string; username: string; server: { uuid: string } }[]>(r).find(
    (x) => x.username === ACCOUNT,
  )!;
}

async function website(page: Page, acct: string, body: Json) {
  const r = await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', '/websites', { hosting_account_uuid: acct, ...body }),
  );
  return (r.resource as { uuid: string }).uuid;
}

test.describe.configure({ mode: 'serial' });

test('Software: cài PHP 8.2 → đổi PHP website; gỡ PHP đang dùng bị chặn', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const acct = await account(page);
  const srv = acct.server.uuid;
  const list = async () =>
    data<{ key: string; installed_version: string | null; remove_blocked: string | null }[]>(
      await call(page, 'admin', 'GET', `/servers/${srv}/software?per_page=100`),
    );
  for (const key of ['php8.3', 'php8.2'])
    if (!(await list()).find((s) => s.key === key)?.installed_version)
      await job(
        page,
        'admin',
        await call(page, 'admin', 'POST', `/servers/${srv}/software/${key}:install`),
      );
  expect((await list()).find((s) => s.key === 'php8.2')?.installed_version).toBeTruthy();

  const site = await website(page, acct.uuid, {
    primary_domain: `php-${SUFFIX}.anphat.vn`,
    type: 'php',
    php_version: '8.3',
    ssl_mode: 'none',
  });
  await job(
    page,
    'admin',
    await whenIdle(page, 'admin', 'PATCH', `/websites/${site}`, { php_version: '8.2' }),
  );
  expect(
    data<{ php_version: string }>(await call(page, 'admin', 'GET', `/websites/${site}`))
      .php_version,
  ).toBe('8.2');

  const php = (await list()).find((s) => s.key === 'php8.2');
  expect(php?.remove_blocked).toContain('website');
  const rm = await call(page, 'admin', 'POST', `/servers/${srv}/software/php8.2:remove`);
  expect(rm.status).toBe(409);

  await page.goto(`/admin/servers/${srv}/software`);
  await expect(page.getByText('PHP 8.2').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Docker: bật → validator chặn privileged → sửa → apply → cổng → website Docker → image lỗi tự quay lại; registry; backup volume', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  await stepUp(page, 'admin', await freshTotp(page));
  const acct = await account(page);
  const srv = acct.server.uuid;

  const host = data<{ state: string }>(await call(page, 'admin', 'GET', `/servers/${srv}/docker`));
  if (host.state !== 'enabled')
    await job(page, 'admin', await call(page, 'admin', 'POST', `/servers/${srv}/docker:enable`));
  expect(
    data<{ state: string }>(await call(page, 'admin', 'GET', `/servers/${srv}/docker`)).state,
  ).toBe('enabled');

  // Template → privileged bị validator chặn (không tạo project), sửa thì chạy.
  const tpl = data<{ key: string; compose_yaml: string }[]>(
    await call(page, 'admin', 'GET', '/compose-templates'),
  );
  expect(tpl.length).toBeGreaterThan(0);
  const name = `web-${SUFFIX}`;
  const yaml =
    'services:\n  app:\n    image: nginx:1.27\n    ports:\n      - "80"\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n';
  const bad = await call(page, 'admin', 'POST', '/compose-projects', {
    server_uuid: srv,
    name,
    compose_yaml: yaml.replace('    ports:', '    privileged: true\n    ports:'),
  });
  expect(bad.status).toBe(422);
  expect(JSON.stringify(bad.body)).toContain('privileged');
  const made = await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', '/compose-projects', {
      server_uuid: srv,
      name,
      compose_yaml: yaml,
    }),
  );
  const proj = (made.resource as { uuid: string }).uuid;
  const p = data<{ status: string; ports: { host_port: number }[] }>(
    await call(page, 'admin', 'GET', `/compose-projects/${proj}`),
  );
  expect(p.status).toBe('running');
  expect(p.ports[0]?.host_port).toBeGreaterThanOrEqual(20000);
  expect(p.ports[0]?.host_port).toBeLessThanOrEqual(29999);

  // Website loại docker → vhost proxy tới cổng đã cấp.
  const domain = `app-${SUFFIX}.anphat.vn`;
  await website(page, acct.uuid, {
    primary_domain: domain,
    type: 'docker',
    ssl_mode: 'none',
    docker_target: { compose_project_uuid: proj, service: 'app' },
  });
  expect(
    data<{ websites: { domain: string }[] }>(
      await call(page, 'admin', 'GET', `/compose-projects/${proj}`),
    ).websites[0]?.domain,
  ).toBe(domain);

  // Bản image mới báo unhealthy → agent tự quay về image cũ.
  control('docker-control.json', { publish: { 'nginx:1.27': SUFFIX }, unhealthy: true });
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `/compose-projects/${proj}:update-images`, { services: [] }),
  );
  const after = data<{ last_image_update: { state: string } | null; status: string }>(
    await call(page, 'admin', 'GET', `/compose-projects/${proj}`),
  );
  expect(after.last_image_update?.state).toBe('rolled_back');
  expect(after.status).toBe('running');
  control('docker-control.json', {});

  // Registry: lưu credential (Crypt), kiểm đăng nhập.
  const reg = await call(page, 'admin', 'POST', '/registries', {
    name: `GHCR ${SUFFIX}`,
    url: 'https://ghcr.io',
    username: 'itso-bot',
    password: `tok-${SUFFIX}`,
  });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const regId = data<{ uuid: string }>(reg).uuid;
  await job(page, 'admin', await call(page, 'admin', 'POST', `/registries/${regId}:test`));
  expect(JSON.stringify(await call(page, 'admin', 'GET', '/registries'))).not.toContain(
    `tok-${SUFFIX}`,
  );

  // Backup volume: policy phạm vi compose project → chạy ngay → snapshot docker_volumes.
  const dests = data<{ uuid: string; type: string }[]>(
    await call(page, 'admin', 'GET', '/backup-destinations'),
  );
  let dest = dests.find((d) => d.type === 'local')?.uuid;
  if (!dest) {
    const d = await call(page, 'admin', 'POST', '/backup-destinations', {
      name: 'Ổ local',
      type: 'local',
      config: { path: '/var/backups/itso' },
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    dest = data<{ uuid: string }>(d).uuid;
  }
  const pol = await call(page, 'admin', 'POST', '/backup-policies', {
    name: `Volume ${SUFFIX}`,
    scope_type: 'compose_project',
    scope_uuid: proj,
    contents: ['docker_volumes'],
    volume_consistency: 'pause',
    schedule: '0 3 * * *',
    destination_uuids: [dest],
  });
  expect(pol.status, JSON.stringify(pol.body)).toBe(201);
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `/backup-policies/${data<{ uuid: string }>(pol).uuid}:run`),
  );
  const snaps = data<{ contents: string[]; scope: { uuid: string } | null }[]>(
    await call(page, 'admin', 'GET', '/backup-snapshots?per_page=100'),
  );
  expect(snaps.some((s) => s.contents.includes('docker_volumes'))).toBe(true);

  await page.goto(`/admin/compose-projects/${proj}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  expect(errors).toEqual([]);
});

test('WordPress: cài → cập nhật lỗi → rolled_back (restic thật) → staging → harden', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const acct = await account(page);
  const domain = `wp-${SUFFIX}.anphat.vn`;
  const site = await website(page, acct.uuid, {
    primary_domain: domain,
    type: 'php',
    php_version: '8.3',
    ssl_mode: 'none',
  });

  control('wp-control.json', { available: {}, fail: {} });
  const inst = await call(page, 'admin', 'POST', '/wordpress/sites', {
    website_uuid: site,
    title: 'An Phát E2E',
    admin_username: 'anphat_e2e',
    admin_email: 'e2e@anphat.vn',
    locale: 'vi',
  });
  const secret = (inst.body as { secret?: string }).secret ?? '';
  expect(secret.length).toBeGreaterThanOrEqual(16);
  const wp = ((await job(page, 'admin', inst)).resource as { uuid: string }).uuid;
  const jobJson = JSON.stringify(
    await call(page, 'admin', 'GET', `/jobs/${(inst.body.job as { uuid: string }).uuid}`),
  );
  expect(jobJson).not.toContain(secret);

  // Có bản mới akismet 5.4 nhưng tải lỗi giữa chừng → agent khôi phục snapshot (file + DB).
  control('wp-control.json', {
    available: { 'plugin/akismet': '5.4' },
    fail: { 'plugin update akismet': 'Download failed.' },
  });
  // Cache wp.info làm mới tối đa 5 phút/lần; lịch hằng đêm `--refresh` ép làm mới ngay.
  artisan('itso:wordpress-auto-update', '--refresh');
  const d0 = data<{ components: { slug: string; latest_version: string | null }[] }>(
    await call(page, 'admin', 'GET', `/wordpress/sites/${wp}`),
  );
  expect(d0.components.find((c) => c.slug === 'akismet')?.latest_version).toBe('5.4');
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `/wordpress/sites/${wp}:update`, { plugins: ['akismet'] }),
  );
  const ups = data<{ state: string; error: string | null; snapshot_uuid: string | null }[]>(
    await call(page, 'admin', 'GET', `/wordpress/sites/${wp}/updates`),
  );
  expect(ups[0]?.state).toBe('rolled_back');
  expect(ups[0]?.error).toContain('Download failed.');
  expect(ups[0]?.snapshot_uuid).not.toBeNull();
  control('wp-control.json', { available: {}, fail: {} });

  await page.goto(`/admin/wordpress/${wp}?tab=updates`);
  await expect(page.getByText('Download failed.').first()).toBeVisible();

  // Staging (noindex) rồi hardening (cờ vhost → nginx.vhost.apply).
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `/wordpress/sites/${wp}:clone-staging`, {
      subdomain: 'staging',
    }),
  );
  const d1 = data<{ staging: { domain: string }[] }>(
    await call(page, 'admin', 'GET', `/wordpress/sites/${wp}`),
  );
  expect(d1.staging[0]?.domain).toBe(`staging.${domain}`);
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `/wordpress/sites/${wp}:harden`, {
      items: ['file_edit_disabled', 'xmlrpc_blocked', 'php_in_uploads_blocked'],
      enabled: true,
    }),
  );
  const d2 = data<{ site: { hardening: Record<string, boolean> } }>(
    await call(page, 'admin', 'GET', `/wordpress/sites/${wp}`),
  );
  expect(d2.site.hardening).toMatchObject({
    file_edit_disabled: true,
    xmlrpc_blocked: true,
    php_in_uploads_blocked: true,
  });
  expect(errors).toEqual([]);
});

test('USER không có đường nào tới Docker; thấy WordPress của mình', async ({ page }) => {
  const errors = watchServerErrors(page);
  await password(page, 'portal', PORTAL_EMAIL);
  await expect(page).toHaveURL(/\/portal\/(dashboard)?$/);
  for (const path of ['/compose-projects', '/registries', '/docker'])
    expect((await call(page, 'portal', 'GET', path)).status).toBe(404);
  const admin = await page.request.get('/api/v1/admin/compose-projects', {
    headers: { Accept: 'application/json' },
  });
  expect([401, 403]).toContain(admin.status());
  await expect(page.getByRole('link', { name: 'Docker' })).toHaveCount(0);
  const wps = data<{ website: { primary_domain: string } }[]>(
    await call(page, 'portal', 'GET', '/wordpress/sites'),
  );
  expect(wps.some((w) => w.website.primary_domain === `wp-${SUFFIX}.anphat.vn`)).toBe(true);
  expect(errors).toEqual([]);
});
