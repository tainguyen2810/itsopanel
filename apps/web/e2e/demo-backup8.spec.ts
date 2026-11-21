import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { asPersona, expect, test, watchErrors } from './demo';

// Prompt 8.0: mockup Backup & Restore trên bản demo: axe sạch ở các màn chính, bộ khôi phục bắt xác nhận.
const SA = '01938a01-0001-7000-8000-000001000001';
const ANPHAT_USER = '01938a01-0003-7000-8000-000001000003';

async function axeClean(page: Page) {
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual(
    [],
  );
}

for (const tab of ['', '?tab=history', '?tab=policies', '?tab=destinations', '?tab=verify']) {
  test(`Backup Center ${tab || 'tổng quan'}: axe sạch, không lỗi`, async ({ page }) => {
    await asPersona(page, 'admin', SA);
    const errors = watchErrors(page);
    await page.goto(`/admin/backups${tab}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Sao lưu' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await axeClean(page);
    expect(errors).toEqual([]);
  });
}

test('tạo đích → bộ khôi phục chỉ đóng được sau khi xác nhận đã lưu', async ({ page }) => {
  await asPersona(page, 'admin', SA);
  await page.goto('/admin/backups?tab=destinations');
  await page.getByRole('button', { name: 'Thêm đích' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('combobox', { name: 'Loại' }).click();
  await page.getByRole('option', { name: 'Ổ đĩa máy chủ' }).click();
  await dlg.getByLabel('Tên đích').fill('Ổ phụ');
  await dlg.getByLabel('Đường dẫn').fill('/mnt/b2');
  await dlg.getByRole('button', { name: 'Lưu' }).click();
  const kit = page.getByRole('dialog', { name: /Bộ khôi phục/ });
  await expect(kit).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(kit).toBeVisible();
  const done = kit.getByRole('button', { name: 'Đã lưu, đóng' });
  await expect(done).toBeDisabled();
  await axeClean(page);
  await kit.getByRole('checkbox', { name: /Tôi đã lưu/ }).check();
  await done.click();
  await expect(kit).toBeHidden();
  await expect(page.getByText('Đã xác nhận lưu bộ khôi phục').first()).toBeVisible();
});

test('Portal sao lưu: quota + snapshot, axe sạch', async ({ page }) => {
  await asPersona(page, 'portal', ANPHAT_USER);
  const errors = watchErrors(page);
  await page.goto('/portal/backups');
  await expect(page.getByText('Quota backup')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await axeClean(page);
  expect(errors).toEqual([]);
});

test('wizard: nhánh khôi phục thảm họa, axe sạch', async ({ page }) => {
  await page.goto('/admin/install');
  await page.getByRole('textbox', { name: 'Mã thiết lập' }).fill('demo-2026-itso');
  await page.getByRole('radio', { name: /Khôi phục từ backup/ }).check();
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(page.getByRole('heading', { name: 'Khôi phục panel từ backup' })).toBeVisible();
  await axeClean(page);
});
