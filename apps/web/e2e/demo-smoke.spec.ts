import { ADMIN_ROUTES } from '../src/entries/admin/routes';
import { PORTAL_ROUTES } from '../src/entries/portal/routes';
import { asPersona, expect, test, urlOf, watchErrors } from './demo';

// Prompt 2.1: mở mọi route của sitemap ở chế độ demo — có tiêu đề, không 404, không lỗi console/API.
const SA = '01938a01-0001-7000-8000-000001000001';
const AD = '01938a01-0002-7000-8000-000001000002';

for (const [realm, defs] of [
  ['admin', ADMIN_ROUTES],
  ['portal', PORTAL_ROUTES],
] as const) {
  test.describe(`smoke ${realm}`, () => {
    for (const def of defs.filter((d) => d.redirect === undefined)) {
      const url = urlOf(realm, def);
      test(`${url}`, async ({ page }) => {
        const errors = watchErrors(page);
        if (realm === 'admin') await asPersona(page, 'admin', SA);
        await page.goto(url);
        const h1 = page.getByRole('heading', { level: 1 });
        await expect(h1).toBeVisible();
        await expect(h1).not.toHaveText(/Không tìm thấy trang|Bạn không có quyền/);
        await page.waitForLoadState('networkidle');
        expect(errors).toEqual([]);
      });
    }
  });
}

test.describe('vai trò demo', () => {
  test('ADMIN (Trần Minh) vào trang chỉ SUPER_ADMIN → 403 thân thiện', async ({ page }) => {
    const errors = watchErrors(page);
    await asPersona(page, 'admin', AD);
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Bạn không có quyền xem trang này',
    );
    expect(errors).toEqual([]);
  });

  test('chuyển vai trò trên topbar, điều hướng bằng sidebar không tải lại trang', async ({
    page,
  }) => {
    await asPersona(page, 'admin', SA);
    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('status-Agent')).toHaveAttribute('data-state', 'ok');
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    await page
      .getByRole('navigation', { name: 'Điều hướng chính' })
      .getByRole('link', { name: /^Website/ })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Website');
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(
      1,
    );

    await page.goto('/admin/settings');
    await page.getByRole('button', { name: /Xem với vai trò/ }).click();
    await page.getByRole('menuitemradio', { name: /Trần Minh/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Bạn không có quyền xem trang này',
    );
  });
});
