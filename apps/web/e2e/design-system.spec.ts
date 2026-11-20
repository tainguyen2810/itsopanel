import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, prepare, test } from './fixtures';

// Mặc định ghi ảnh vào test-results (không làm bẩn Git). `make screenshots` đặt
// SCREENSHOT_DIR=docs/screenshots/design-system để cập nhật ảnh tài liệu.
const OUT = process.env.SCREENSHOT_DIR
  ? resolve(process.env.SCREENSHOT_DIR)
  : resolve(import.meta.dirname, '../test-results/screenshots');
const PAGES = [
  { name: 'design', path: '/design/', ready: '#sec-jobs' },
  { name: 'admin-shell', path: '/admin/', ready: '[data-testid="status-Agent"][data-state="ok"]' },
  { name: 'portal-shell', path: '/portal/', ready: '[data-testid="status-API"][data-state="ok"]' },
] as const;
const WIDTHS = [1440, 390] as const;
const THEMES = ['light', 'dark'] as const;

test.describe('ảnh chụp Design System', () => {
  for (const p of PAGES) {
    for (const w of WIDTHS) {
      for (const theme of THEMES) {
        test(`${p.name} ${w}px ${theme}`, async ({ page }) => {
          await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
          await prepare(page, { theme });
          await page.goto(p.path);
          await page.locator(p.ready).waitFor();
          await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
          // Không có cuộn ngang ở mọi độ rộng.
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          expect(overflow).toBeLessThanOrEqual(0);
          await page.screenshot({
            path: `${OUT}/${p.name}-${w}-${theme}.png`,
            animations: 'disabled',
            fullPage: p.name === 'design',
          });
        });
      }
    }
  }

  for (const theme of THEMES) {
    test(`admin-shell 390px drawer ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await prepare(page, { theme });
      await page.goto('/admin/');
      // Chờ router chuyển /admin/ → /admin/dashboard và trang tải xong rồi mới mở menu.
      await page.locator('[data-testid="status-Agent"][data-state="ok"]').waitFor();
      await expect(page.getByRole('navigation', { name: 'Điều hướng chính' })).toBeHidden();
      await page.getByRole('button', { name: 'Mở menu' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('link', { name: /Máy chủ/ })).toBeVisible();
      // Chờ hiệu ứng mở drawer chạy xong để ảnh không bị mờ giữa chừng.
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
      );
      // Drawer phải nằm trên lớp phủ (z-index token): điểm giữa drawer thuộc về dialog.
      const onTop = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      });
      expect(onTop).toBe(true);
      await page.screenshot({
        path: `${OUT}/admin-shell-390-${theme}-drawer.png`,
        animations: 'disabled',
      });
    });
  }
});

test.describe('hành vi shell', () => {
  test('không nháy sai theme: .dark có trước khi React chạy', async ({ page }) => {
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        (window as unknown as { __darkAtDCL: boolean }).__darkAtDCL =
          document.documentElement.classList.contains('dark');
      });
    });
    await prepare(page, { theme: 'dark' });
    await page.goto('/admin/');
    expect(
      await page.evaluate(() => (window as unknown as { __darkAtDCL: boolean }).__darkAtDCL),
    ).toBe(true);
  });

  test('Ctrl+K mở tìm nhanh và điều hướng', async ({ page }) => {
    await prepare(page, { theme: 'light' });
    await page.goto('/admin/');
    await page.locator('[data-testid="status-API"]').waitFor();
    await page.keyboard.press('Control+k');
    const box = page.getByRole('combobox');
    await expect(box).toBeFocused();
    await box.fill('Sao lưu');
    await expect(page.getByRole('option', { name: 'Sao lưu' })).toBeVisible();
  });

  test('đổi theme và ngôn ngữ từ topbar, lưu lại sau khi tải lại', async ({ page }) => {
    await prepare(page, { theme: 'light' });
    await page.goto('/admin/');
    await page.getByRole('button', { name: 'Giao diện' }).click();
    await page.getByRole('menuitemradio', { name: 'Tối' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByRole('button', { name: /^Ngôn ngữ/ }).click();
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  });

  test('thu gọn sidebar ở desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page, { theme: 'light' });
    await page.goto('/admin/');
    await page.getByRole('button', { name: 'Thu gọn thanh bên' }).click();
    const aside = page.locator('aside');
    await expect(aside).toHaveClass(/w-18/);
    await expect(page.getByRole('link', { name: 'Máy chủ' })).toBeVisible();
  });
});

test.describe('a11y (axe-core)', () => {
  for (const p of PAGES) {
    for (const theme of THEMES) {
      for (const lang of ['vi', 'en'] as const) {
        test(`${p.name} ${theme} ${lang}: 0 lỗi critical/serious`, async ({ page }) => {
          await prepare(page, { theme, lang });
          await page.goto(p.path);
          await page.locator(p.ready).waitFor();
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .analyze();
          const bad = results.violations.filter(
            (v) => v.impact === 'critical' || v.impact === 'serious',
          );
          expect(
            bad.map(
              (v) =>
                `${v.id}: ${v.nodes
                  .map((n) => n.target.join(' '))
                  .slice(0, 3)
                  .join(' | ')}`,
            ),
          ).toEqual([]);
        });
      }
    }
  }
});
