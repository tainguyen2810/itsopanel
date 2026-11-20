import { resolve } from 'node:path';
import { asPersona, data, expect, test } from './demo';

// Prompt 2.8: ảnh trang chính (Admin + Portal) 1440/390 × light/dark ở chế độ demo.
// Mặc định ghi vào test-results; `make screenshots` đặt SCREENSHOT_DIR_P2=docs/screenshots/phase-2.
const OUT = process.env.SCREENSHOT_DIR_P2
  ? resolve(process.env.SCREENSHOT_DIR_P2)
  : resolve(import.meta.dirname, '../test-results/screenshots-phase-2');
const SA = '01938a01-0001-7000-8000-000001000001';
const anphat = data.accounts.find((a) => a.username === 'anphat')?.uuid ?? 'missing';
const site = data.websites[0]?.uuid ?? 'missing';
const server = data.servers[0]?.uuid ?? 'missing';

const PAGES = [
  ['admin-dashboard', '/admin/dashboard'],
  ['admin-servers', '/admin/servers'],
  ['admin-server-detail', `/admin/servers/${server}`],
  ['admin-hosting-accounts', '/admin/hosting-accounts'],
  ['admin-account-detail', `/admin/hosting-accounts/${anphat}`],
  ['admin-websites', '/admin/websites'],
  ['admin-website-detail', `/admin/websites/${site}`],
  ['admin-backups', '/admin/backups'],
  ['admin-security', '/admin/security'],
  ['admin-audit-logs', '/admin/audit-logs'],
  ['portal-overview', '/portal/'],
  ['portal-account', `/portal/accounts/${anphat}`],
  ['portal-websites', '/portal/websites'],
  ['portal-backups', '/portal/backups'],
] as const;

for (const [name, url] of PAGES) {
  for (const w of [1440, 390] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${name} ${w} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
        await page.addInitScript((t) => localStorage.setItem('itso.theme', t), theme);
        if (url.startsWith('/admin')) await asPersona(page, 'admin', SA);
        await page.goto(url);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
        await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png`, animations: 'disabled' });
      });
    }
  }
}
