import { asPersona, data, expect, test, watchErrors } from './demo';

// Prompt 2.2: luồng lõi admin trên bản demo (dashboard, tìm kiếm, đăng nhập, wizard cài đặt).
const SA = '01938a01-0001-7000-8000-000001000001';
const AD = '01938a01-0002-7000-8000-000001000002';

/** Đếm bản ghi qua API giả lập (MSW trong trình duyệt, cùng tiêu đề vai trò với app). */
async function apiCount(page: import('@playwright/test').Page, path: string, actor: string) {
  return page.evaluate(
    async ([p, a]) => {
      const r = await fetch(`/api/v1/admin/${p}?limit=200`, {
        headers: { 'X-Demo-User': a, 'X-Demo-Realm': 'admin' },
      });
      return ((await r.json()) as { data: unknown[] }).data.length;
    },
    [path, actor] as const,
  );
}

test.describe('dashboard', () => {
  for (const [who, actor] of [
    ['SUPER_ADMIN', SA],
    ['ADMIN (Trần Minh)', AD],
  ] as const) {
    test(`số trên thẻ thống kê khớp số bản ghi danh sách — ${who}`, async ({ page }) => {
      const errors = watchErrors(page);
      await asPersona(page, 'admin', actor);
      await page.goto('/admin/dashboard');
      for (const [href, path] of [
        ['/admin/servers', 'servers'],
        ['/admin/websites', 'websites'],
        ['/admin/databases', 'databases'],
      ] as const) {
        const card = page.locator(`main a[href="${href}"]`).first();
        await expect(card).toBeVisible();
        const n = await apiCount(page, path, actor);
        await expect(card).toContainText(String(n));
      }
      expect(errors).toEqual([]);
    });
  }

  test('bấm server trong danh sách dashboard → trang chi tiết server', async ({ page }) => {
    const errors = watchErrors(page);
    await asPersona(page, 'admin', SA);
    await page.goto('/admin/dashboard');
    const srv = data.servers[0];
    await page
      .getByRole('link', { name: srv?.name ?? '', exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/admin/servers/${srv?.uuid}$`));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test('Ctrl+K tìm account theo username, Enter mở trang chi tiết', async ({ page }) => {
  const errors = watchErrors(page);
  await asPersona(page, 'admin', SA);
  await page.goto('/admin/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.type('anphat');
  const opt = dialog.getByRole('option', { name: /anphat/ }).first();
  await expect(opt).toBeVisible();
  await opt.click();
  await expect(page).toHaveURL(/\/admin\/(hosting-accounts|websites)\//);
  expect(errors).toEqual([]);
});

test('đăng nhập → MFA (mã sai báo lỗi, mã đúng vào dashboard)', async ({ page }) => {
  await asPersona(page, 'admin', SA);
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill('admin@itso.local');
  await page.getByLabel('Mật khẩu').fill('mat-khau-demo-123');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page).toHaveURL(/\/admin\/login\/mfa$/);
  const code = page.getByLabel('Mã xác thực');
  await code.fill('000000');
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page.getByText('Mã không đúng')).toBeVisible();
  await code.fill('123456');
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Chào mừng trở lại/);
});

test('wizard cài đặt: chặn bước khi thiếu dữ liệu, sang bước khi hợp lệ, quay lại được', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/admin/install');
  const stepTitle = page.locator('#step-title');
  await expect(stepTitle).toHaveText('Mã thiết lập');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(stepTitle).toHaveText('Mã thiết lập');
  const codeBox = page.getByRole('textbox', { name: 'Mã thiết lập' });
  await expect(codeBox).toHaveAttribute('aria-invalid', 'true');
  // Mã đúng định dạng nhưng sai → API trả 422, vẫn ở bước 0. Bản demo nhận mã DEMO-2026-ITSO.
  await codeBox.fill('ab12-cd34-ef56');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(page.getByText('Mã thiết lập không đúng.')).toBeVisible();
  await expect(stepTitle).toHaveText('Mã thiết lập');
  await codeBox.fill('demo-2026-itso');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(stepTitle).toHaveText('Ngôn ngữ');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(stepTitle).toHaveText('Super Admin và MFA');
  await page.getByRole('button', { name: 'Quay lại' }).click();
  await expect(stepTitle).toHaveText('Ngôn ngữ');
  // Chỉ chấp nhận đúng một lỗi đã chủ động gây ra: 422 của mã sai (kèm dòng console của trình duyệt).
  const expected422 = (e: string) =>
    /^422 .*\/api\/v1\/admin\/setup\/code:verify$/.test(e) ||
    e.startsWith('console: Failed to load resource: the server responded with a status of 422');
  expect(errors.filter(expected422)).toHaveLength(2);
  expect(errors.filter((e) => !expected422(e))).toEqual([]);
});
