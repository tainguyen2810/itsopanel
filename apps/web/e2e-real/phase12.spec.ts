import { expect, test, type Page } from '@playwright/test';
import { adminLogin, freshTotp, SUFFIX, watchServerErrors } from './helpers';

// Prompt 12.8: Import, CIS, Sẵn sàng production trên stack thật + itso-agent --sandbox. Panel nguồn là cây file giả do
// sandbox seed (aaPanel /www, HestiaCP /usr/local/hestia, nginx thuần /etc/nginx) — xem agent/internal/ops/sandbox_import.go.
// Domain đã import ở lượt chạy trước bị bỏ chọn (`domain_exists`), nên test lấy mục chọn được đầu tiên qua các nguồn.

type Json = Record<string, unknown>;
type Realm = 'admin' | 'portal';

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
  const j = data<{ state: string; error?: unknown }>(
    await call(page, 'admin', 'GET', `/jobs/${uuid}`),
  );
  expect(j.state, JSON.stringify(j)).toBe('succeeded');
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

async function localServer(page: Page) {
  const r = await call(page, 'admin', 'GET', '/servers?per_page=100');
  const s = data<{ uuid: string; name: string }[]>(r).find((x) => x.name === 'srv-local');
  expect(s, 'cần server srv-local (make dev chạy itso:server-local)').toBeTruthy();
  return s!;
}

/** PHP 8.3 phải sẵn sàng trên srv-local (site import có PHP cần một bản đã cài mà gói cho phép). */
async function ensurePhp(page: Page, srv: string) {
  const installed = async () =>
    data<{ version: string; installed: boolean }[]>(
      await call(page, 'admin', 'GET', `/servers/${srv}/php-versions`),
    ).find((v) => v.version === '8.3')?.installed ?? false;
  if (await installed()) return;
  const r = await call(page, 'admin', 'POST', `/servers/${srv}/php-versions/8.3:install`);
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  await expect.poll(installed, { timeout: 60_000 }).toBe(true);
}

type Item = { uuid: string; domain: string; selected: boolean; state: string; result: Json | null };
type Import = { uuid: string; state: string; summary: { sites: number; selected: number } };

test.describe.configure({ mode: 'serial' });

test('Import: quét nguồn giả → kế hoạch → chạy → báo cáo → cutover → quay lại', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const srv = await localServer(page);
  await ensurePhp(page, srv.uuid);
  const pkg = data<{ uuid: string }[]>(await call(page, 'admin', 'GET', '/hosting-packages'))[0]!;

  // Quét lần lượt aaPanel → HestiaCP → nginx tới khi có mục chọn được.
  let imp: Import | undefined;
  let pick: Item | undefined;
  for (const source of ['aapanel', 'hestia', 'nginx']) {
    const r = await job(
      page,
      await call(page, 'admin', 'POST', '/imports', { source, server: srv.uuid }),
    );
    const id = (r.resource as { uuid: string }).uuid;
    imp = data<Import>(await call(page, 'admin', 'GET', `/imports/${id}`));
    expect(imp.state).toBe('planned');
    expect(imp.summary.sites).toBeGreaterThan(0);
    const items = data<Item[]>(
      await call(page, 'admin', 'GET', `/imports/${id}/items?sort=domain`),
    );
    pick = items.find((i) => i.selected);
    if (pick) break;
  }
  expect(
    pick,
    'mọi site giả đã được import ở lượt trước: xóa sandbox (.dev/agent-sandbox) để chạy lại',
  ).toBeTruthy();
  const id = imp!.uuid;

  // UI: trang chi tiết hiện kế hoạch.
  await page.goto(`/admin/imports/${id}`);
  await expect(page.getByText(pick!.domain).first()).toBeVisible();

  // Kế hoạch: chỉ chọn một site, account mới + USER mới (hậu tố ngẫu nhiên).
  const username = `imp${SUFFIX}`;
  const items = data<Item[]>(await call(page, 'admin', 'GET', `/imports/${id}/items`));
  const plan = await call(page, 'admin', 'PUT', `/imports/${id}/plan`, {
    items: items.map((i) =>
      i.uuid === pick!.uuid
        ? {
            uuid: i.uuid,
            selected: true,
            username,
            package: pkg.uuid,
            new_user: { name: `Import ${SUFFIX}`, email: `import-${SUFFIX}@itso.local` },
          }
        : { uuid: i.uuid, selected: false },
    ),
  });
  expect(plan.status, JSON.stringify(plan.body)).toBe(200);

  await stepUp(page);
  await job(page, await call(page, 'admin', 'POST', `/imports/${id}:run`));
  await expect
    .poll(async () => data<Import>(await call(page, 'admin', 'GET', `/imports/${id}`)).state, {
      timeout: 120_000,
    })
    .toBe('completed');
  const done = data<Item[]>(await call(page, 'admin', 'GET', `/imports/${id}/items`)).find(
    (i) => i.uuid === pick!.uuid,
  )!;
  expect(done.state).toBe('done');
  expect((done.result as { hosting_account: { username: string } }).hosting_account.username).toBe(
    username,
  );
  const accounts = data<{ username: string; status: string }[]>(
    await call(page, 'admin', 'GET', `/hosting-accounts?per_page=100&q=${username}`),
  );
  expect(accounts.find((a) => a.username === username)?.status).toBe('ready');

  // UI: báo cáo khác biệt.
  await page.goto(`/admin/imports/${id}`);
  await expect(page.getByText(username).first()).toBeVisible();

  // Cutover rồi quay lại: account ITSO giữ nguyên.
  await job(page, await call(page, 'admin', 'POST', `/imports/${id}:cutover`));
  await expect
    .poll(async () => data<Import>(await call(page, 'admin', 'GET', `/imports/${id}`)).state)
    .toBe('cut_over');
  await job(page, await call(page, 'admin', 'POST', `/imports/${id}:rollback`));
  expect(data<Import>(await call(page, 'admin', 'GET', `/imports/${id}`)).state).toBe(
    'rolled_back',
  );
  const after = data<{ username: string }[]>(
    await call(page, 'admin', 'GET', `/hosting-accounts?per_page=100&q=${username}`),
  );
  expect(after.some((a) => a.username === username)).toBe(true);
  expect(errors).toEqual([]);
});

test('CIS: chạy kiểm (job chỉ đọc) → điểm + mục trên trang CIS', async ({ page }) => {
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const srv = await localServer(page);
  await job(page, await call(page, 'admin', 'POST', `/security/cis:audit?server=${srv.uuid}`));
  const rep = data<{ score: number | null; items: { id: string; status: string }[] }>(
    await call(page, 'admin', 'GET', `/security/cis?server=${srv.uuid}`),
  );
  expect(rep.items.length).toBeGreaterThan(10);
  expect(rep.score).not.toBeNull();
  await page.goto(`/admin/security/cis?server=${srv.uuid}`);
  await expect(page.getByText('Điểm CIS').first()).toBeVisible();
  await expect(page.getByText(rep.items[0]!.id).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Sẵn sàng production: kiểm tự động từ dữ liệu thật + Gate chờ VM', async ({ page }) => {
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const r = await call(page, 'admin', 'GET', '/system/readiness');
  expect(r.status).toBe(200);
  const d = data<{
    ready: boolean;
    checks: { key: string; status: string; detail: string }[];
    gate: { status: string }[];
  }>(r);
  const cis = d.checks.find((c) => c.key === 'cis_score');
  expect(cis?.detail).not.toContain('srv-local: chưa quét'); // vừa kiểm CIS ở test trên
  expect(d.gate).toHaveLength(8);
  expect(d.ready).toBe(false); // Gate chưa có bằng chứng VM
  await page.goto('/admin/system/readiness');
  await expect(page.getByText('Production Gate G1–G8').first()).toBeVisible();
  await expect(page.getByText('Chưa sẵn sàng production').first()).toBeVisible();
  expect(errors).toEqual([]);
});
