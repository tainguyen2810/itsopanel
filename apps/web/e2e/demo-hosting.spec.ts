import { asPersona, expect, test, watchErrors } from './demo';

// Prompt 2.4: gói hosting và tài khoản hosting trên bản demo.
const SA = '01938a01-0001-7000-8000-000001000001';
const BASIC = '01938a03-0001-7000-8000-000003000001';
const LEHOA = '01938a05-0003-7000-8000-000005000003';

test.beforeEach(async ({ page }) => {
  await asPersona(page, 'admin', SA);
});

const nav = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Điều hướng chính' });

test('tạo tài khoản qua wizard → job xong → xuất hiện trong danh sách', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/admin/hosting-accounts/new');
  const next = page.getByRole('button', { name: 'Tiếp' });

  // Bước 1: chưa chọn chủ sở hữu thì không qua được.
  await next.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Chọn chủ sở hữu' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Chủ sở hữu' }).click();
  await page.getByRole('option', { name: /Phòng Marketing/ }).click();
  await next.click();

  await page.getByRole('radio', { name: /Basic/ }).check();
  await next.click();
  await expect(page.getByText('Gợi ý')).toBeVisible();
  await page.getByRole('radio', { name: /srv-hn-02/ }).check();
  await next.click();

  // Username gợi ý từ tên chủ sở hữu; trùng username có sẵn bị API từ chối ở bước cuối.
  const username = page.getByLabel('Username', { exact: true });
  await expect(username).toHaveValue('marketing');
  await username.fill('root');
  await next.click();
  await expect(page.getByText('Tên này dành cho hệ thống')).toBeVisible();
  await username.fill('mktsale');
  await page.getByLabel(/Domain chính/).fill('sale.itso.vn');
  await next.click();

  await expect(page.getByRole('heading', { name: 'Xác nhận' })).toBeVisible();
  await expect(page.getByText('/home/mktsale')).toBeVisible();
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();

  await expect(page.getByText('Đã xong: Tạo tài khoản hosting')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'mktsale' })).toBeVisible();
  await expect(page.getByText('Hoạt động').first()).toBeVisible();

  await nav(page).getByRole('link', { name: 'Tài khoản hosting' }).click();
  await expect(page.getByRole('link', { name: 'mktsale' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('purge 2 bước (D-46): người lên lịch không tự xác nhận được, Super Admin khác xác nhận khi hết hạn giữ', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/admin/hosting-accounts/terminated');
  const row = page.getByRole('row', { name: /oldshop/ });
  await expect(row).toContainText('Chờ Super Admin thứ hai');
  await row.getByRole('button', { name: 'Xác nhận purge' }).click();
  const other = page.getByRole('alertdialog', { name: 'Cần một Super Admin khác' });
  await expect(other).toBeVisible();
  await other.getByRole('button', { name: 'Đã hiểu' }).click();

  // Đổi vai trò demo sang Super Admin thứ hai (không tải lại trang).
  await page.getByRole('button', { name: /Xem với vai trò/ }).click();
  await page.getByRole('menuitemradio', { name: /Nguyễn Hải/ }).click();
  await row.getByRole('button', { name: 'Xác nhận purge' }).click();
  const dlg = page.getByRole('alertdialog', { name: 'Xác nhận purge oldshop?' });
  const ok = dlg.getByRole('button', { name: 'Xác nhận purge' });
  await expect(ok).toBeDisabled();
  await dlg.getByRole('textbox').fill('oldshop');
  await ok.click();
  // Như API thật: đã hết hạn giữ dữ liệu → xác nhận là xóa ngay (account.remove), account rời danh sách.
  await expect(page.getByText('Đã xong: Xóa vĩnh viễn tài khoản')).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: /oldshop/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('sửa giới hạn gói tạo phiên bản mới (D-43) và so sánh được với phiên bản cũ', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto(`/admin/hosting-packages/${BASIC}`);
  await page.getByRole('button', { name: 'Sửa giới hạn' }).click();
  await expect(page.getByText('Lưu thay đổi giới hạn sẽ tạo phiên bản 3')).toBeVisible();
  await page.getByLabel('RAM (MB)').fill('2048');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu gói hosting')).toBeVisible();
  await expect(page.getByText('v3', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'So sánh' }).click();
  const ram = page.getByRole('row', { name: /RAM \(MB\)/ });
  await expect(ram).toContainText('1 GB');
  await expect(ram).toContainText('2 GB');
  await expect(ram).toContainText('đã đổi');
  expect(errors).toEqual([]);
});

test('chuyển máy chủ: kiểm tra xong → cutover → tài khoản ở máy đích', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(`/admin/hosting-accounts/${LEHOA}/migrate`);
  await expect(page.getByRole('heading', { name: 'Kiểm tra dữ liệu' })).toBeVisible();
  await page.getByRole('button', { name: 'Cutover' }).click();
  const dlg = page.getByRole('alertdialog', { name: /Cutover sang srv-hn-02/ });
  await dlg.getByRole('textbox').fill('lehoa');
  await dlg.getByRole('button', { name: 'Cutover' }).click();
  await expect(page.getByText('Đã xong: Cutover chuyển máy chủ')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByText('Đã chuyển sang srv-hn-02')).toBeVisible();
  await page.getByRole('link', { name: 'Về tài khoản' }).click();
  await expect(page.getByRole('heading', { name: 'lehoa' })).toBeVisible();
  await expect(page.getByText(/Lê Hoa · srv-hn-02/)).toBeVisible();
  expect(errors).toEqual([]);
});
