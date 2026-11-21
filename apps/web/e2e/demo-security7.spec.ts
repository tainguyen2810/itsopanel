import AxeBuilder from '@axe-core/playwright';
import { asPersona, data, expect, test, watchErrors } from './demo';

// Prompt 7.6: UI nối API thật trên bản demo: gỡ chặn IP fail2ban, xem trước ruleset tường lửa.
const SA = '01938a01-0001-7000-8000-000001000001';
const S1 = data.servers[0]?.uuid ?? '';

test.beforeEach(async ({ page }) => {
  await asPersona(page, 'admin', SA);
});

test('fail2ban: danh sách IP bị chặn → gỡ chặn một IP; axe sạch', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/admin/security/fail2ban');
  const table = page.getByRole('table', { name: 'IP đang bị chặn' });
  const unban = table.getByRole('button', { name: /^Gỡ chặn / }).first();
  await expect(unban).toBeVisible();
  const label = (await unban.getAttribute('aria-label')) ?? '';
  const before = await table.getByRole('button', { name: /^Gỡ chặn / }).count();
  await unban.click();
  await expect(page.getByText('Đã gỡ chặn IP').first()).toBeVisible({ timeout: 10_000 });
  // Drawer theo dõi job mở ra (job fail2ban.unban); đóng lại để xem bảng.
  await expect(page.getByRole('dialog', { name: 'Theo dõi tác vụ' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(table.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await expect(table.getByRole('button', { name: /^Gỡ chặn / })).toHaveCount(before - 1);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations.filter((v) => ['critical', 'serious'].includes(v.impact ?? ''))).toEqual(
    [],
  );
  expect(errors).toEqual([]);
});

test('tường lửa: hộp áp dụng hiện ruleset xem trước', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto(`/admin/servers/${S1}/firewall`);
  await page.getByRole('button', { name: 'Thêm rule' }).click();
  const form = page.getByRole('dialog', { name: 'Thêm rule tường lửa' });
  await form.getByLabel('Cổng').fill('9091');
  await form.getByLabel('Nguồn').fill('10.10.0.0/16');
  await form.getByRole('button', { name: 'Lưu' }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: 'Áp dụng' }).click();
  const dlg = page.getByRole('dialog', { name: 'Áp dụng tường lửa an toàn' });
  await expect(dlg.getByTestId('firewall-preview')).toBeVisible({ timeout: 10_000 });
  await expect(dlg.getByText(/Ruleset sẽ áp dụng \(\d+ rule\)/)).toBeVisible();
  expect(errors).toEqual([]);
});
