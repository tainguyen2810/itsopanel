import { asPersona, expect, test, watchErrors } from './demo';

// Prompt 2.5: website, File Manager, DNS, cron, Git deploy trên bản demo.
const SA = '01938a01-0001-7000-8000-000001000001';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';

test.beforeEach(async ({ page }) => {
  await asPersona(page, 'admin', SA);
});

test('tạo website → job xong → website sẵn sàng trong danh sách', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/admin/websites');
  await page.getByRole('button', { name: 'Thêm website' }).click();
  const dlg = page.getByRole('dialog', { name: 'Thêm website' });

  // Gửi khi chưa đủ dữ liệu: báo lỗi ngay trên form, chưa gọi API.
  await dlg.getByRole('button', { name: 'Tạo website' }).click();
  await expect(dlg.getByText('Chọn tài khoản hosting').first()).toBeVisible();

  await dlg.getByRole('combobox', { name: 'Tài khoản' }).click();
  await page.getByRole('option', { name: /^anphat/ }).click();
  await expect(dlg.getByText('Đã dùng 2/10 website của gói')).toBeVisible();
  await dlg.getByLabel('Domain').fill('Moi.Anphat.vn');
  await dlg.getByRole('combobox', { name: 'Phiên bản PHP' }).click();
  await page.getByRole('option', { name: 'PHP 8.2' }).click();
  await dlg.getByLabel('Thư mục gốc').fill('../../etc');
  await dlg.getByRole('button', { name: 'Tạo website' }).click();
  await expect(dlg.getByText('Đường dẫn tương đối')).toBeVisible();
  await dlg.getByLabel('Thư mục gốc').fill('public');
  await dlg.getByRole('button', { name: 'Tạo website' }).click();

  await expect(page.getByText('Đã xong: Tạo website')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox').fill('moi.anphat');
  const row = page.getByRole('row', { name: /moi\.anphat\.vn/ });
  await expect(row).toContainText('Sẵn sàng');
  await expect(row).toContainText('PHP 8.2');
  await row.getByRole('link', { name: 'moi.anphat.vn' }).click();
  await expect(page.getByRole('heading', { name: 'moi.anphat.vn' })).toBeVisible();
  await page.getByRole('tab', { name: 'SSL' }).click();
  await expect(page.getByRole('cell', { name: "Let's Encrypt R11" })).toBeVisible();
  expect(errors).toEqual([]);
});

test('File Manager: chặn đường dẫn ngoài home, sửa file, tạo thư mục', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(`/admin/files?account=${ANPHAT}`);
  const path = page.getByRole('textbox', { name: 'Đường dẫn' });
  await path.fill('/etc/passwd');
  await page.getByRole('button', { name: 'Mở', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'ngoài /home/anphat' })).toBeVisible();

  await path.fill('~/sites/anphat.vn/public');
  await page.getByRole('button', { name: 'Mở', exact: true }).click();
  await page.getByRole('button', { name: 'index.php', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'index.php' });
  const box = editor.getByLabel('Nội dung file');
  await expect(box).toContainText('<?php');
  await box.fill('<?php echo "xin chao";');
  await editor.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu file')).toBeVisible();

  // Tạo thư mục mới qua job rồi thấy ngay trong danh sách.
  await page.getByRole('button', { name: 'Thư mục mới' }).click();
  const mk = page.getByRole('dialog', { name: 'Tạo thư mục' });
  await mk.getByLabel('Tên thư mục').fill('../x');
  await expect(mk.getByRole('alert')).toBeVisible();
  await mk.getByLabel('Tên thư mục').fill('assets');
  await mk.getByRole('button', { name: 'Tạo' }).click();
  await expect(page.getByText('Đã xong: Tạo thư mục')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'assets', exact: true }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('DNS: form record kiểm tra theo loại, thêm record A → job → có trong zone', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/admin/dns');
  await page.getByRole('button', { name: 'Thêm record' }).click();
  const dlg = page.getByRole('dialog', { name: /Thêm record vào anphat\.vn/ });
  await dlg.getByLabel('Tên').fill('api');
  await dlg.getByLabel('Nội dung').fill('300.1.1.1');
  await dlg.getByRole('button', { name: 'Thêm record' }).click();
  await expect(dlg.getByText('Địa chỉ IPv4 không hợp lệ')).toBeVisible();
  await dlg.getByLabel('Nội dung').fill('203.0.113.20');
  await dlg.getByRole('button', { name: 'Thêm record' }).click();
  await expect(page.getByText('Đã xong: Thêm record DNS')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: /api.*203\.0\.113\.20/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Cron: xem trước lịch, chạy ngay và xem lịch sử; Git: deploy rồi quay lại', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/admin/cron');
  await page.getByRole('button', { name: 'Thêm cron job' }).click();
  const dlg = page.getByRole('dialog', { name: 'Thêm cron job' });
  await dlg.getByLabel('Lịch chạy').fill('0 2 * * *');
  await expect(dlg.getByText('Hằng ngày lúc 02:00').first()).toBeVisible();
  await dlg.getByLabel('Lịch chạy').fill('61 * * * *');
  await expect(dlg.getByText('Biểu thức cron 5 trường').first()).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Thao tác cho cron php artisan schedule:run' }).click();
  await page.getByRole('menuitem', { name: 'Chạy ngay' }).click();
  await expect(page.getByText('Đã xong: Chạy cron job thủ công')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Thao tác cho cron php artisan schedule:run' }).click();
  await page.getByRole('menuitem', { name: 'Lịch sử chạy' }).click();
  await expect(page.getByText('Đã chạy xong (thủ công).')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/admin/git-deployments');
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await expect(page.getByText('Đã xong: Deploy từ Git')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Thao tác cho commit a41c9e2' }).click();
  await page.getByRole('menuitem', { name: 'Quay về release này' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Quay về release này' }).click();
  await expect(page.getByText('Đã xong: Quay về release trước')).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: /a41c9e2/ }).first()).toContainText('Đang chạy');
  expect(errors).toEqual([]);
});

// Prompt 5.5: nhà cung cấp DNS, gắn/đồng bộ/gỡ zone; tải chứng chỉ riêng kiểm tra PEM.
test('DNS: xem nhà cung cấp, gắn zone Cloudflare, đồng bộ rồi gỡ khỏi panel', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/admin/dns');
  await page.getByRole('button', { name: 'Nhà cung cấp DNS' }).click();
  const providers = page.getByRole('dialog', { name: 'Nhà cung cấp DNS' });
  await expect(providers.getByText('Cloudflare ITSO')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Gắn zone' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Gắn zone' });
  await dlg.getByRole('button', { name: 'Gắn zone' }).click();
  await expect(dlg.getByRole('alert').filter({ hasText: 'Chọn nhà cung cấp' })).toBeVisible();
  await dlg.getByRole('combobox', { name: 'Nhà cung cấp' }).click();
  await page.getByRole('option', { name: 'Cloudflare ITSO' }).click();
  await dlg.getByLabel('Tên zone').fill('Moi-Zone.vn');
  await dlg.getByRole('combobox', { name: 'Tài khoản hosting' }).click();
  await page.getByRole('option', { name: /^anphat/ }).click();
  await dlg.getByRole('button', { name: 'Gắn zone' }).click();
  await expect(page.getByText('Đã gắn zone')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Record của moi-zone.vn' })).toBeVisible();

  await page.getByRole('button', { name: 'Đồng bộ từ Cloudflare' }).click();
  await expect(page.getByText('Đã đồng bộ moi-zone.vn từ Cloudflare')).toBeVisible();
  await page.getByRole('button', { name: 'Thao tác zone moi-zone.vn' }).click();
  await page.getByRole('menuitem', { name: 'Gỡ zone khỏi panel' }).click();
  await page
    .getByRole('alertdialog', { name: 'Gỡ moi-zone.vn khỏi panel?' })
    .getByRole('button', { name: 'Gỡ zone khỏi panel' })
    .click();
  await expect(page.getByText('Đã gỡ moi-zone.vn khỏi panel')).toBeVisible();
  await expect(page.getByRole('button', { name: /moi-zone\.vn/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('SSL: tải chứng chỉ riêng kiểm tra PEM trước khi gửi', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/admin/websites');
  await page.getByRole('link', { name: 'anphat.vn', exact: true }).click();
  await page.getByRole('tab', { name: 'SSL' }).click();
  await page.getByRole('button', { name: 'Tải chứng chỉ riêng' }).click();
  const dlg = page.getByRole('dialog', { name: /Tải chứng chỉ cho anphat\.vn/ });
  await dlg.getByLabel('Chứng chỉ (PEM)').fill('không phải pem');
  await dlg.getByRole('button', { name: 'Tải chứng chỉ riêng' }).click();
  await expect(dlg.getByText('Cần chứng chỉ PEM')).toBeVisible();
  await expect(dlg.getByText('Cần khóa riêng PEM không mật khẩu')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

// Prompt 6.5: tải lên theo chunk có tiến độ; mật khẩu do panel sinh chỉ hiện một lần.
test('File Manager: tải file lên theo chunk, xong thì file có trong thư mục', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(`/admin/files?account=${ANPHAT}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'p6-upload.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('xin chao phase 6\n'),
  });
  const panel = page.getByRole('region', { name: 'Đang tải lên' });
  await expect(panel.getByText('p6-upload.txt')).toBeVisible();
  await expect(panel.getByText('Xong')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'p6-upload.txt', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('SFTP: tạo tài khoản không nhập mật khẩu → mật khẩu hiện một lần', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/admin/sftp');
  await page.getByRole('button', { name: 'Thêm tài khoản SFTP' }).click();
  const dlg = page.getByRole('dialog', { name: 'Thêm tài khoản SFTP' });
  await dlg.getByRole('combobox', { name: 'Tài khoản' }).click();
  await page.getByRole('option', { name: /^anphat/ }).click();
  await dlg.getByLabel('Username').fill('anphat_e2e');
  await dlg.getByRole('button', { name: 'Tạo' }).click();
  const secret = page.getByRole('dialog', { name: 'Mật khẩu mới' });
  await expect(secret).toBeVisible({ timeout: 15_000 });
  await expect(secret.getByRole('alert')).toBeVisible();
  expect(errors).toEqual([]);
});
