import { expect, test, type Page } from '@playwright/test';
import {
  adminLogin,
  freshTotp,
  password,
  PORTAL_EMAIL,
  SUFFIX,
  watchServerErrors,
} from './helpers';

// Prompt 5.6: stack thật + itso-agent --sandbox. Website PHP: tạo → job (layout → pool → vhost) → alias →
// SSL (lego sandbox cấp chứng chỉ tự ký) → tạm khóa account thấy trạng thái → xóa. Portal tạo website của mình.
// Cần ITSO_ACME_EMAIL khi chạy `make dev` (ACME bắt buộc có email liên hệ).

const ACCOUNT = 'anphat';

async function accountUuid(page: Page, username: string): Promise<string> {
  const res = await page.request.get('/api/v1/admin/hosting-accounts?per_page=100');
  expect(res.ok()).toBeTruthy();
  const rows = ((await res.json()) as { data: { uuid: string; username: string }[] }).data;
  const a = rows.find((x) => x.username === username);
  expect(a, username).toBeTruthy();
  return a!.uuid;
}

/** Chờ job trong drawer xong rồi đóng drawer. */
async function jobDone(page: Page, title: string) {
  await expect(page.getByText(`Đã xong: ${title}`)).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
}

/** PHP 8.3 phải ở trạng thái ready trên server của account (PHP Manager → php.version.install qua agent sandbox). */
async function ensurePhp(page: Page) {
  const servers = await page.request.get('/api/v1/admin/servers?per_page=50');
  const rows = ((await servers.json()) as { data: { uuid: string; name: string }[] }).data;
  const srv = rows.find((x) => x.name === 'srv-local') ?? rows[0];
  const list = async () =>
    (
      (await (
        await page.request.get(`/api/v1/admin/servers/${srv!.uuid}/php-versions`)
      ).json()) as {
        data: { version: string; installed: boolean }[];
      }
    ).data.find((v) => v.version === '8.3')?.installed ?? false;
  if (await list()) return;
  const xsrf = (await page.context().cookies()).find((c) => c.name === 'XSRF-TOKEN-ADMIN')?.value;
  const r = await page.request.post(`/api/v1/admin/servers/${srv!.uuid}/php-versions/8.3:install`, {
    headers: {
      'Idempotency-Key': crypto.randomUUID(),
      'X-XSRF-TOKEN': decodeURIComponent(xsrf ?? ''),
    },
  });
  expect(r.status(), await r.text()).toBe(202);
  await expect.poll(list, { timeout: 60_000 }).toBe(true);
}

async function createSite(page: Page, domain: string, realm: 'admin' | 'portal') {
  // Admin: hộp thoại; Portal: trang riêng /portal/websites/new.
  await page.getByRole(realm === 'admin' ? 'button' : 'link', { name: 'Thêm website' }).click();
  const dlg =
    realm === 'admin' ? page.getByRole('dialog', { name: 'Thêm website' }) : page.getByRole('main');
  const accountLabel = new RegExp(`^${ACCOUNT}`);
  {
    await dlg.getByRole('combobox', { name: 'Tài khoản' }).click();
    await page.getByRole('option', { name: accountLabel }).click();
  }
  await dlg.getByLabel('Domain').fill(domain);
  await dlg.getByRole('combobox', { name: 'Phiên bản PHP' }).click();
  await page.getByRole('option', { name: 'PHP 8.3' }).click();
  await dlg.getByRole('combobox', { name: 'SSL' }).click();
  await page.getByRole('option', { name: 'Chưa bật SSL' }).click();
  await dlg.getByRole('button', { name: 'Tạo website' }).click();
}

test('Website PHP: tạo → alias → SSL sandbox → tạm khóa account → xóa', async ({ page }) => {
  const errors = watchServerErrors(page);
  await adminLogin(page);
  await ensurePhp(page);
  const acc = await accountUuid(page, ACCOUNT);
  const domain = `e2e-${SUFFIX}.anphat.vn`;

  await page.goto('/admin/websites');
  await createSite(page, domain, 'admin');
  await jobDone(page, 'Tạo website');
  await page.getByRole('searchbox').fill(domain);
  const row = page.getByRole('row', { name: new RegExp(domain.replaceAll('.', '\\.')) });
  await expect(row).toContainText('Sẵn sàng', { timeout: 15_000 });
  await row.getByRole('link', { name: domain }).click();
  await expect(page.getByRole('heading', { name: domain })).toBeVisible();

  // Alias: domain thêm vào vhost qua job.
  await page.getByRole('tab', { name: 'Domain' }).click();
  await page.getByRole('button', { name: 'Thêm domain' }).click();
  const add = page.getByRole('dialog', { name: `Thêm domain cho ${domain}` });
  await add.getByRole('textbox', { name: 'Domain' }).fill(`www.${domain}`);
  await add.getByRole('button', { name: 'Thêm domain' }).click();
  await jobDone(page, 'Thêm domain cho website');
  await expect(
    page.getByRole('cell', { name: `www.${domain}`, exact: true }).first(),
  ).toBeVisible();

  // SSL: lego sandbox cấp chứng chỉ tự ký → vhost bật tls.
  await page.getByRole('tab', { name: 'SSL' }).click();
  await page.getByRole('button', { name: "Xin chứng chỉ Let's Encrypt" }).click();
  await jobDone(page, 'Cấp chứng chỉ SSL');
  await expect(page.getByRole('cell', { name: 'Hợp lệ' })).toBeVisible({ timeout: 15_000 });

  // Tạm khóa account → website hiện trạng thái tạm khóa (vhost trang khóa).
  await page.goto(`/admin/hosting-accounts/${acc}`);
  await page.getByRole('button', { name: 'Thao tác' }).click();
  await page.getByRole('menuitem', { name: 'Tạm khóa' }).click();
  const lock = page.getByRole('dialog', { name: `Tạm khóa ${ACCOUNT}?` });
  await lock.getByLabel('Lý do').fill('Kiểm thử e2e Phase 5');
  await lock.getByRole('button', { name: 'Tạm khóa' }).click();
  await jobDone(page, 'Tạm khóa tài khoản hosting');
  const site = await page.request.get(`/api/v1/admin/websites?q=${domain}`);
  const w = ((await site.json()) as { data: { uuid: string; status: string }[] }).data[0];
  expect(w?.status).toBe('suspended');
  await page.getByRole('button', { name: 'Thao tác' }).click();
  await page.getByRole('menuitem', { name: 'Mở khóa' }).click();
  await page
    .getByRole('alertdialog', { name: `Mở khóa ${ACCOUNT}?` })
    .getByRole('button', { name: 'Mở khóa' })
    .click();
  await jobDone(page, 'Mở khóa tài khoản hosting');

  // Xóa website: nhập đúng domain để xác nhận → vhost/pool gỡ qua job.
  await page.goto(`/admin/websites/${w!.uuid}`);
  await page.getByRole('button', { name: 'Thao tác' }).click();
  await page.getByRole('menuitem', { name: 'Xóa website' }).click();
  const del = page.getByRole('alertdialog', { name: `Xóa website ${domain}?` });
  await del.getByRole('textbox').fill(domain);
  await del.getByRole('button', { name: 'Xóa website' }).click();
  // Xóa website là thao tác nhạy cảm: API trả 403 mfa_step_up_required → hộp thoại hỏi lại mã TOTP rồi gửi lại.
  const stepUp = page.getByRole('dialog', { name: 'Xác thực lại để tiếp tục' });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel('Mã 6 số').fill(await freshTotp(page));
  await stepUp.getByRole('button', { name: 'Xác nhận và tiếp tục' }).click();
  await jobDone(page, 'Xóa website');
  const gone = await page.request.get(`/api/v1/admin/websites?q=${domain}`);
  expect(((await gone.json()) as { data: unknown[] }).data).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('Portal: khách tự tạo website cho account của mình', async ({ page }) => {
  const errors = watchServerErrors(page);
  await password(page, 'portal', PORTAL_EMAIL);
  await expect(page).toHaveURL(/\/portal\/?$/);
  const domain = `portal-${SUFFIX}.anphat.vn`;
  await page.goto('/portal/websites');
  await createSite(page, domain, 'portal');
  await jobDone(page, 'Tạo website');
  await page.getByRole('searchbox').fill(domain);
  await expect(
    page.getByRole('row', { name: new RegExp(domain.replaceAll('.', '\\.')) }),
  ).toContainText('Sẵn sàng', { timeout: 15_000 });
  expect(errors).toEqual([]);
});
