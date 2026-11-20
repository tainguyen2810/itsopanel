import { readFile } from 'node:fs/promises';
import { asPersona, expect, test, watchErrors } from './demo';

// Prompt 2.6: wizard khôi phục, xuất CSV nhật ký kiểm toán trên bản demo.
const SA = '01938a01-0001-7000-8000-000001000001';

test.beforeEach(async ({ page }) => {
  await asPersona(page, 'admin', SA);
});

test('wizard khôi phục: kiểm từng bước, ghi đè cần gõ username → job → có trong danh sách', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/admin/restores');
  await page.getByRole('link', { name: 'Khôi phục mới' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Khôi phục từ backup');

  // Bước 1: chưa chọn snapshot thì không qua được.
  await page.getByRole('button', { name: 'Tiếp' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Chọn một snapshot' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Tài khoản' }).click();
  await page.getByRole('option', { name: /^anphat/ }).click();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Tiếp' }).click();

  // Bước 2: chọn database + cấu hình.
  await expect(page.getByRole('heading', { name: 'Chọn nội dung' })).toBeVisible();
  await page.getByRole('button', { name: 'Tiếp' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Chọn ít nhất một mục cần khôi phục' }),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: /anphat_shop/ }).check();
  await page.getByRole('checkbox', { name: /Cấu hình account/ }).check();
  await expect(page.getByText('Đã chọn 2 mục')).toBeVisible();
  await page.getByRole('button', { name: 'Tiếp' }).click();

  // Bước 3: ghi đè phải gõ đúng username.
  await page.getByRole('radio', { name: /Ghi đè bản đang chạy/ }).check();
  await expect(page.getByText('Ghi đè dữ liệu đang chạy')).toBeVisible();
  await page.getByLabel('Gõ anphat để xác nhận').fill('anpha');
  await page.getByRole('button', { name: 'Tiếp' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Gõ đúng "anphat" để ghi đè' }),
  ).toBeVisible();
  await page.getByLabel('Gõ anphat để xác nhận').fill('anphat');
  await page.getByRole('button', { name: 'Tiếp' }).click();

  // Bước 4: xem lại rồi bắt đầu.
  await expect(page.getByText('config, database:anphat_shop').first()).toBeVisible();
  await page.getByRole('button', { name: 'Bắt đầu khôi phục' }).click();
  await expect(page.getByText('Đã xong: Khôi phục từ bản sao lưu')).toBeVisible({
    timeout: 15_000,
  });
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/\/admin\/restores$/);
  const row = page.getByRole('row', { name: /database:anphat_shop/ }).first();
  await expect(row).toContainText('anphat');
  await expect(row).toContainText('Thành công');
  expect(errors).toEqual([]);
});

test('khôi phục ra bản mới từ nút trên snapshot, sang máy chủ khác', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/admin/backups');
  const row = page.getByRole('row', { name: /^anphat/ }).first();
  await row.getByRole('button', { name: /Thao tác/ }).click();
  await page.getByRole('menuitem', { name: 'Khôi phục…' }).click();
  await expect(page).toHaveURL(/\/admin\/restores\/new\?snapshot=/);
  // Snapshot đã được chọn sẵn → vào thẳng bước chọn nội dung.
  await expect(page.getByRole('radio').first()).toBeChecked();
  await page.getByRole('button', { name: 'Tiếp' }).click();
  await page.getByRole('checkbox', { name: /Toàn bộ thư mục sites/ }).check();
  await page.getByRole('button', { name: 'Tiếp' }).click();
  await page.getByRole('combobox', { name: 'Máy chủ đích' }).click();
  await page.getByRole('option', { name: 'srv-hn-02' }).click();
  await page.getByRole('button', { name: 'Tiếp' }).click();
  await expect(page.getByText('srv-hn-02').first()).toBeVisible();
  await page.getByRole('button', { name: 'Bắt đầu khôi phục' }).click();
  await expect(page.getByText('Đã xong: Khôi phục từ bản sao lưu')).toBeVisible({
    timeout: 15_000,
  });
  expect(errors).toEqual([]);
});

test('nhật ký kiểm toán: lọc theo kết quả, xem chi tiết, xuất CSV', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/admin/audit-logs');
  await page.getByRole('combobox', { name: /Kết quả/ }).click();
  await page.getByRole('option', { name: 'Thất bại' }).click();
  await expect(page.getByRole('row').nth(1)).toContainText('Thất bại');
  await page.getByRole('row').nth(1).getByRole('button', { name: 'Chi tiết' }).click();
  await expect(page.getByRole('dialog')).toContainText('Thất bại');
  await page.keyboard.press('Escape');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Xuất CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^audit-logs-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = (await readFile((await file.path()) ?? '', 'utf8')).replace(/^\uFEFF/, '');
  const [header, ...lines] = text.trim().split('\n');
  expect(header).toBe('at,actor,impersonator,actor_ip,action,resource,server,result,job_uuid,hash');
  expect(lines.length).toBeGreaterThan(5);
  await expect(page.getByText(/Đã xuất \d+ dòng/)).toBeVisible();
  expect(errors).toEqual([]);
});
