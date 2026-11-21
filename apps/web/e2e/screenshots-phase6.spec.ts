import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { asPersona, data, expect, test } from './demo';

// Mockup Phase 6 (làm bù sau 6.6): màn hình dữ liệu hosting ở chế độ demo, 1440/390 × light/dark, gồm cả trạng thái
// quan trọng (hộp thoại tạo, mật khẩu hiện một lần, trình soạn thảo, bảng tải lên, lịch sử cron, terminal).
// Mặc định ghi vào test-results; `make screenshots` đặt SCREENSHOT_DIR_P6=docs/screenshots/phase-6.
const OUT = process.env.SCREENSHOT_DIR_P6
  ? resolve(process.env.SCREENSHOT_DIR_P6)
  : resolve(import.meta.dirname, '../test-results/screenshots-phase-6');
const SA = '01938a01-0001-7000-8000-000001000001';
const anphat = data.accounts.find((a) => a.username === 'anphat')?.uuid ?? 'missing';
const server = data.servers[0]?.uuid ?? 'missing';
const pub = encodeURIComponent('sites/anphat.vn/public');

type Shot = readonly [name: string, url: string, act?: (p: Page) => Promise<void>];

const PAGES: readonly Shot[] = [
  ['admin-databases', '/admin/databases'],
  ['admin-database-users', '/admin/databases?tab=users'],
  [
    'admin-database-create',
    '/admin/databases',
    async (p) => {
      await p.getByRole('button', { name: 'Thêm database' }).click();
      await expect(p.getByRole('dialog', { name: 'Thêm database' })).toBeVisible();
    },
  ],
  ['admin-files', `/admin/files?account=${anphat}&path=${pub}`],
  [
    'admin-files-editor',
    `/admin/files?account=${anphat}&path=${pub}`,
    async (p) => {
      await p.getByRole('button', { name: 'index.php', exact: true }).click();
      await expect(p.getByRole('dialog', { name: 'index.php' })).toBeVisible();
    },
  ],
  [
    'admin-files-upload',
    `/admin/files?account=${anphat}&path=${pub}`,
    async (p) => {
      await p.locator('input[type="file"]').setInputFiles([
        { name: 'banner.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(180_000, 1) },
        { name: 'robots.txt', mimeType: 'text/plain', buffer: Buffer.from('User-agent: *\n') },
      ]);
      await expect(
        p.getByRole('region', { name: 'Đang tải lên' }).getByText('Xong').first(),
      ).toBeVisible();
    },
  ],
  ['admin-sftp', '/admin/sftp'],
  ['admin-sftp-keys', '/admin/sftp?tab=keys'],
  [
    'admin-sftp-secret',
    '/admin/sftp',
    async (p) => {
      await p.getByRole('button', { name: 'Thêm tài khoản SFTP' }).click();
      const dlg = p.getByRole('dialog', { name: 'Thêm tài khoản SFTP' });
      await dlg.getByRole('combobox', { name: 'Tài khoản' }).click();
      await p.getByRole('option', { name: /^anphat/ }).click();
      await dlg.getByLabel('Username').fill('anphat_design');
      await dlg.getByRole('button', { name: 'Tạo' }).click();
      await expect(p.getByRole('dialog', { name: 'Mật khẩu mới' })).toBeVisible({
        timeout: 15_000,
      });
    },
  ],
  ['admin-cron', '/admin/cron'],
  [
    'admin-cron-history',
    '/admin/cron',
    async (p) => {
      await p
        .getByRole('button', { name: /^Thao tác cho cron/ })
        .first()
        .click();
      await p.getByRole('menuitem', { name: 'Lịch sử chạy' }).click();
      await expect(p.getByRole('dialog', { name: 'Lịch sử chạy' })).toBeVisible();
    },
  ],
  [
    'admin-terminal',
    `/admin/servers/${server}/terminal`,
    async (p) => {
      await p.getByRole('button', { name: 'Kết nối' }).click();
      await expect(p.getByRole('button', { name: 'Ngắt kết nối' })).toBeVisible({
        timeout: 15_000,
      });
      for (const cmd of ['whoami', 'hostname', 'ls']) {
        await p.locator('#term-input').fill(cmd);
        await p.keyboard.press('Enter');
      }
    },
  ],
  ['portal-databases', '/portal/databases'],
  ['portal-files', `/portal/files?account=${anphat}`],
  ['portal-sftp', '/portal/sftp'],
  ['portal-cron', '/portal/cron'],
  ['portal-terminal', '/portal/terminal'],
];

for (const [name, url, act] of PAGES) {
  for (const w of [1440, 390] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${name} ${w} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
        await page.addInitScript((t) => localStorage.setItem('itso.theme', t), theme);
        if (url.startsWith('/admin')) await asPersona(page, 'admin', SA);
        await page.goto(url);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.waitForLoadState('networkidle');
        if (act) await act(page);
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
        await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png`, animations: 'disabled' });
      });
    }
  }
}
