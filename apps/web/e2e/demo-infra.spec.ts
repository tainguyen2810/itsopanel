import { asPersona, data, expect, test, watchErrors } from './demo';

// Prompt 2.3: luồng hạ tầng trên bản demo (job dịch vụ, tường lửa safe-apply, thêm server, compose).
const SA = '01938a01-0001-7000-8000-000001000001';
const S1 = data.servers[0]?.uuid ?? '';

test.beforeEach(async ({ page }) => {
  await asPersona(page, 'admin', SA);
});

test('khởi động lại dịch vụ → job chạy từng bước tới khi xong', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(`/admin/servers/${S1}?tab=services`);
  await page.getByRole('button', { name: 'Thao tác với nginx' }).click();
  await page.getByRole('menuitem', { name: 'Khởi động lại' }).click();
  const drawer = page.getByRole('dialog', { name: 'Theo dõi tác vụ' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Khởi động lại dịch vụ').first()).toBeVisible();
  await expect(page.getByText('Đã xong: Khởi động lại dịch vụ')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  // Điều hướng trong SPA (tải lại trang sẽ làm mới dữ liệu demo trong bộ nhớ).
  await page
    .getByRole('navigation', { name: 'Điều hướng chính' })
    .getByRole('link', { name: /^Tác vụ/ })
    .click();
  await expect(page.getByRole('row').nth(1)).toContainText('Khởi động lại dịch vụ');
  await expect(page.getByRole('row').nth(1)).toContainText('Thành công');
  expect(errors).toEqual([]);
});

test('tường lửa: thêm rule → áp dụng an toàn → đếm ngược → giữ cấu hình', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(`/admin/servers/${S1}/firewall`);
  const apply = page.getByRole('button', { name: 'Áp dụng' });
  await expect(apply).toBeDisabled();
  await page.getByRole('button', { name: 'Thêm rule' }).click();
  const form = page.getByRole('dialog', { name: 'Thêm rule tường lửa' });
  await form.getByLabel('Cổng').fill('99999');
  await form.getByLabel('Nguồn').fill('10.10.0.0/16');
  await form.getByRole('button', { name: 'Lưu' }).click();
  await expect(form.getByText('Cổng 1–65535')).toBeVisible();
  await form.getByLabel('Cổng').fill('9090');
  await form.getByRole('button', { name: 'Lưu' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText('1 thay đổi chưa áp dụng')).toBeVisible();
  await expect(page.getByRole('cell', { name: '9090' })).toBeVisible();

  await apply.click();
  const dlg = page.getByRole('dialog', { name: 'Áp dụng tường lửa an toàn' });
  await dlg.getByLabel('Tự hoàn tác sau (giây)').fill('60');
  await dlg.getByRole('button', { name: 'Áp dụng' }).click();
  const countdown = page.getByTestId('firewall-countdown');
  await expect(countdown).toBeVisible({ timeout: 10_000 });
  const first = Number(/\d+/.exec((await countdown.textContent()) ?? '')?.[0]);
  await expect
    .poll(async () => Number(/\d+/.exec((await countdown.textContent()) ?? '')?.[0]))
    .toBeLessThan(first);
  await page.getByRole('button', { name: 'Giữ cấu hình mới' }).click();
  await expect(page.getByText('Đã xác nhận cấu hình tường lửa mới')).toBeVisible({
    timeout: 10_000,
  });
  expect(errors).toEqual([]);
});

test('thêm server: tạo token → lệnh cài agent → agent kết nối → mở server mới', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/admin/servers/new');
  await page.getByLabel('Tên').fill('srv-hcm-02');
  await page.getByRole('button', { name: 'Tạo token đăng ký' }).click();
  await expect(page.getByText(/--token itso_enr_\w+ --ca-sha256 [0-9a-f]{64}/)).toBeVisible();
  await expect(page.getByText('Máy chủ srv-hcm-02 đã kết nối')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: 'Mở máy chủ' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('srv-hcm-02');
  await page
    .getByRole('navigation', { name: 'Đường dẫn' })
    .getByRole('link', { name: 'Máy chủ' })
    .click();
  await expect(page.getByRole('link', { name: 'srv-hcm-02' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('compose: tạo project → trang chi tiết → chạy', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/admin/compose-projects');
  await page.getByRole('button', { name: 'Tạo project' }).click();
  const dlg = page.getByRole('dialog', { name: 'Tạo compose project' });
  await dlg.getByRole('combobox', { name: 'Máy chủ' }).click();
  // Server đã bật Docker (server chưa bật → validator trả 409).
  await page.getByRole('option', { name: 'srv-hn-01' }).click();
  await dlg.getByLabel('Tên project').fill('web-demo');
  // Phase 10 (D-96): phải Kiểm tra (validator) trước, nút triển khai mới bật.
  const deploy = dlg.getByRole('button', { name: 'Kiểm tra và triển khai' });
  await expect(deploy).toBeDisabled();
  await dlg.getByRole('button', { name: 'Kiểm tra', exact: true }).click();
  await expect(dlg.getByText(/compose.yaml hợp lệ|Hợp lệ, có ghi chú/)).toBeVisible();
  await deploy.click();
  // Drawer theo dõi job mở (modal); đóng để xem trang chi tiết.
  const drawer = page.getByRole('dialog', { name: 'Theo dõi tác vụ' });
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('web-demo');
  await expect(page.getByRole('main').locator('header').getByText('Đang chạy')).toBeVisible({
    timeout: 15_000,
  });
  expect(errors).toEqual([]);
});
