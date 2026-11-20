import type { Page } from '@playwright/test';
import { asPersona, expect, test, watchErrors } from './demo';

// Prompt 2.7: Portal chỉ hiện dữ liệu của USER đang đăng nhập; đổi user demo → chỉ thấy dữ liệu
// của user mới, không có menu/route admin.
const ANPHAT_USER = '01938a01-0003-7000-8000-000001000003';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const SITE_ANPHAT = '01938a06-0001-7000-8000-000006000001';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Điều hướng chính' });
const table = (page: Page) => page.getByRole('table');

async function switchUser(page: Page, name: string) {
  await page.getByRole('button', { name: /Xem với vai trò/ }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(name) }).click();
}

test('đổi user demo trên portal → chỉ thấy website, database, account của mình', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await asPersona(page, 'portal', ANPHAT_USER);
  await page.goto('/portal/websites');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Website');
  await expect(table(page).getByRole('link', { name: 'anphat.vn', exact: true })).toBeVisible();
  await expect(table(page).getByRole('link', { name: 'shop.anphat.vn' })).toBeVisible();
  await expect(table(page)).not.toContainText('marketing.itso.vn');
  // Cột hạ tầng chỉ Admin có.
  await expect(table(page).getByRole('columnheader', { name: 'WAF' })).toHaveCount(0);

  await switchUser(page, 'Phòng Marketing');
  await expect(table(page).getByRole('link', { name: 'marketing.itso.vn' })).toBeVisible();
  await expect(table(page)).not.toContainText('anphat.vn');

  // Điều hướng trong SPA (dữ liệu demo nằm trong bộ nhớ trình duyệt).
  await nav(page)
    .getByRole('link', { name: /^Cơ sở dữ liệu/ })
    .click();
  await expect(table(page)).toContainText('mktitso_cms');
  await expect(table(page)).not.toContainText('anphat_');

  await nav(page)
    .getByRole('link', { name: /^Tổng quan/ })
    .click();
  await expect(page.getByRole('link', { name: /mktitso/ }).first()).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText('anphat');

  // Menu portal không có chức năng admin.
  const hrefs = await nav(page)
    .getByRole('link')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
  expect(hrefs.every((h) => h.startsWith('/portal/'))).toBe(true);
  expect(hrefs.some((h) => /servers|users|hosting-packages|firewall|audit/.test(h))).toBe(false);

  await switchUser(page, 'Công ty An Phát');
  await nav(page)
    .getByRole('link', { name: /^Website/ })
    .click();
  await expect(table(page).getByRole('link', { name: 'anphat.vn', exact: true })).toBeVisible();
  await expect(table(page)).not.toContainText('marketing.itso.vn');
  expect(errors).toEqual([]);
});

test('mở thẳng URL account/website của user khác → không thấy dữ liệu', async ({ page }) => {
  await asPersona(page, 'portal', '01938a01-0004-7000-8000-000001000004');
  for (const url of [`/portal/accounts/${ANPHAT}`, `/portal/websites/${SITE_ANPHAT}`]) {
    await page.goto(url);
    await expect(page.getByRole('main')).toContainText(/Không tìm thấy/);
    await expect(page.getByRole('main')).not.toContainText('anphat.vn');
  }
});
