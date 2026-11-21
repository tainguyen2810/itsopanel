import { expect, test } from '@playwright/test';
import { adminLogin, watchServerErrors } from './helpers';

// Prompt 4.6: stack thật với agent thật ở chế độ sandbox (`make dev` mặc định chạy itso-agent --sandbox, ký HMAC).
// Server detail đọc dữ kiện agent báo (system.info), điều khiển dịch vụ qua job → service.control; account có mức sử dụng.

async function localServer(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.get('/api/v1/admin/servers?per_page=50');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { data: { uuid: string; name: string }[] };
  const s = body.data.find((x) => x.name === 'srv-local') ?? body.data[0];
  expect(s).toBeTruthy();
  return s!.uuid;
}

test('Server detail: thẻ Nền tảng báo agent sandbox; khởi động lại nginx qua job thành công', async ({
  page,
}) => {
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const uuid = await localServer(page);

  await page.goto(`/admin/servers/${uuid}?tab=agent`);
  await expect(page.getByText('Nền tảng', { exact: true })).toBeVisible();
  await expect(page.getByText('Sandbox (không đổi máy thật)')).toBeVisible();
  await expect(page.getByText('amd64')).toBeVisible();

  await page.getByRole('tab', { name: 'Dịch vụ' }).click();
  await page.getByRole('button', { name: 'Thao tác với nginx' }).click();
  await page.getByRole('menuitem', { name: 'Khởi động lại' }).click();
  const drawer = page.getByRole('dialog', { name: 'Theo dõi tác vụ' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Khởi động lại dịch vụ').first()).toBeVisible();
  await expect(drawer.getByText('Thành công')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');

  await page.getByRole('tab', { name: 'Tài nguyên' }).click();
  await expect(page.getByText('Dung lượng đã cấp')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Account: tab Tổng quan có mức sử dụng (đĩa, inode, CPU, RAM) từ snapshot', async ({
  page,
}) => {
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const res = await page.request.get('/api/v1/admin/hosting-accounts?per_page=50');
  expect(res.ok()).toBeTruthy();
  const accounts = (
    (await res.json()) as { data: { uuid: string; username: string; lifecycle_state: string }[] }
  ).data;
  const a = accounts.find((x) => x.lifecycle_state === 'active');
  expect(a).toBeTruthy();

  await page.goto(`/admin/hosting-accounts/${a!.uuid}`);
  await expect(page.getByText('Mức sử dụng')).toBeVisible();
  for (const label of ['Đĩa', 'Inode', 'CPU', 'RAM']) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  const usage = await page.request.get(`/api/v1/admin/hosting-accounts/${a!.uuid}/usage`);
  expect(usage.status()).toBe(200);
  expect(errors).toEqual([]);
});
