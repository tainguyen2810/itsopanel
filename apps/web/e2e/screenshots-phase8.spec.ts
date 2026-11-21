import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { asPersona, data, expect, test } from './demo';

// Mockup Phase 8 (Prompt 8.0, trước khi code): Backup & Restore ở chế độ demo, 1440/390 × light/dark, gồm
// trạng thái quan trọng (3-2-1-1-0 chưa đạt, bộ khôi phục một lần, đích bất biến không xóa snapshot, quota
// tạm dừng, khôi phục ghi đè cần step-up, purge chờ kiểm chứng, khôi phục thảm họa từ wizard).
// Mặc định ghi vào test-results; `make screenshots` đặt SCREENSHOT_DIR_P8=docs/screenshots/phase-8.
const OUT = process.env.SCREENSHOT_DIR_P8
  ? resolve(process.env.SCREENSHOT_DIR_P8)
  : resolve(import.meta.dirname, '../test-results/screenshots-phase-8');
const SA = '01938a01-0001-7000-8000-000001000001';
const ANPHAT_USER = '01938a01-0003-7000-8000-000001000003';
const snap = data.snapshots[0]?.uuid ?? 'missing';
const mktitso = data.accounts.find((a) => a.username === 'mktitso')?.uuid ?? 'missing';

type Shot = readonly [name: string, url: string, act?: (p: Page) => Promise<void>];

const menu = async (p: Page, label: RegExp, item: string) => {
  await p.getByRole('button', { name: label }).first().click();
  await p.getByRole('menuitem', { name: item }).click();
};

const PAGES: readonly Shot[] = [
  ['admin-backups-overview', '/admin/backups'],
  ['admin-backups-destinations', '/admin/backups?tab=destinations'],
  [
    'admin-backups-dest-sftp',
    '/admin/backups?tab=destinations',
    async (p) => {
      await p.getByRole('button', { name: 'Thêm đích' }).click();
      const dlg = p.getByRole('dialog');
      await dlg.getByRole('combobox', { name: 'Loại' }).click();
      await p.getByRole('option', { name: 'SFTP' }).click();
      await dlg.getByLabel('Tên đích').fill('SFTP kho dự phòng');
      await dlg.getByLabel('Máy chủ').fill('backup2.itso.local');
      await dlg.getByLabel('Người dùng').fill('itso-backup');
      await dlg.getByLabel('Đường dẫn').fill('/srv/backup/itso');
    },
  ],
  [
    'admin-backups-recovery-kit',
    '/admin/backups?tab=destinations',
    async (p) => {
      await p.getByRole('button', { name: 'Thêm đích' }).click();
      const dlg = p.getByRole('dialog');
      await dlg.getByRole('combobox', { name: 'Loại' }).click();
      await p.getByRole('option', { name: 'Ổ đĩa máy chủ' }).click();
      await dlg.getByLabel('Tên đích').fill('Ổ phụ srv-hn-01');
      await dlg.getByLabel('Đường dẫn').fill('/mnt/backup2/itso');
      await dlg.getByRole('button', { name: 'Lưu' }).click();
      await expect(p.getByRole('dialog', { name: /Bộ khôi phục/ })).toBeVisible();
      await p.getByRole('checkbox', { name: /Tôi đã lưu bộ khôi phục/ }).check();
    },
  ],
  [
    'admin-backups-repos',
    '/admin/backups?tab=destinations',
    async (p) => {
      await menu(p, /Thao tác cho đích S3/, 'Xem repo');
      await expect(
        p
          .getByRole('dialog')
          .getByText('mktitso', { exact: true })
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
    },
  ],
  ['admin-backups-policies', '/admin/backups?tab=policies'],
  [
    'admin-backups-policy-form',
    '/admin/backups?tab=policies',
    async (p) => {
      await p.getByRole('button', { name: 'Thêm chính sách' }).click();
      const dlg = p.getByRole('dialog');
      await dlg.getByLabel('Tên chính sách').fill('Website anphat.vn hằng ngày');
      await dlg.getByRole('combobox', { name: 'Phạm vi' }).click();
      await p.getByRole('option', { name: 'Một website' }).click();
      await dlg.getByRole('checkbox', { name: 'S3 Object Lock (offsite)' }).check();
      await expect(dlg.getByText(/số bản giữ chỉ là mong muốn/)).toBeVisible();
    },
  ],
  ['admin-backups-snapshots', '/admin/backups?tab=history'],
  [
    'admin-backups-snapshot-detail',
    '/admin/backups?tab=history',
    async (p) => {
      await menu(p, /Thao tác cho snapshot 4f2a9c1e/, 'Chi tiết');
      await expect(p.getByRole('dialog').getByText(/Bất biến tới/)).toBeVisible();
    },
  ],
  [
    'admin-backups-browse-file',
    '/admin/backups?tab=history',
    async (p) => {
      await menu(p, /Thao tác cho snapshot 4f2a9c1e/, 'Xem nội dung');
      const dlg = p.getByRole('dialog');
      await dlg.getByRole('button', { name: 'sites', exact: true }).click();
      await dlg.getByRole('button', { name: 'anphat.vn', exact: true }).click();
      await dlg.getByRole('button', { name: 'Tải .env' }).click();
      await expect(dlg.getByText(/dùng một lần/)).toBeVisible();
    },
  ],
  ['admin-backups-verify', '/admin/backups?tab=verify'],
  [
    'admin-restore-overwrite',
    `/admin/restores/new?snapshot=${snap}`,
    async (p) => {
      await p.getByRole('button', { name: 'Tiếp' }).click();
      await p.getByRole('checkbox', { name: /anphat_shop/ }).check();
      await p.getByRole('button', { name: 'Tiếp' }).click();
      await p.getByRole('radio', { name: /Ghi đè bản đang chạy/ }).check();
      await expect(p.getByText('Cần xác thực lại MFA')).toBeVisible();
    },
  ],
  [
    'admin-restore-review',
    `/admin/restores/new?snapshot=${snap}`,
    async (p) => {
      await p.getByRole('button', { name: 'Tiếp' }).click();
      await p.getByRole('checkbox', { name: /anphat_shop/ }).check();
      await p.getByRole('checkbox', { name: /^anphat\.vn/ }).check();
      await p.getByRole('button', { name: 'Tiếp' }).click();
      await p.getByRole('button', { name: 'Tiếp' }).click();
      await expect(p.getByText(/database mới anphat_shop_r/)).toBeVisible();
    },
  ],
  ['admin-restores', '/admin/restores'],
  ['admin-account-backup', `/admin/hosting-accounts/${mktitso}?tab=backup`],
  ['admin-terminated-purge', '/admin/hosting-accounts/terminated'],
  [
    'install-dr-choice',
    '/admin/install',
    async (p) => {
      await p.getByRole('textbox', { name: 'Mã thiết lập' }).fill('demo-2026-itso');
      await p.getByRole('radio', { name: /Khôi phục từ backup/ }).check();
    },
  ],
  [
    'install-dr-source',
    '/admin/install',
    async (p) => {
      await openDr(p);
    },
  ],
  [
    'install-dr-pick',
    '/admin/install',
    async (p) => {
      await openDr(p);
      await p.getByRole('button', { name: 'Mở repo' }).click();
      await expect(p.getByText('Mới nhất', { exact: true })).toBeVisible();
    },
  ],
  ['portal-backups', '/portal/backups'],
  [
    'portal-restore-overwrite',
    `/portal/backups?tab=restore&snapshot=${snap}`,
    async (p) => {
      await p.getByRole('button', { name: 'Tiếp' }).click();
      await p.getByRole('checkbox', { name: /anphat_shop/ }).check();
      await p.getByRole('button', { name: 'Tiếp' }).click();
      await p.getByRole('radio', { name: /Ghi đè bản đang chạy/ }).check();
      await expect(p.getByText('Cần xác thực lại MFA')).toBeVisible();
    },
  ],
];

/** Wizard: mã thiết lập → chọn khôi phục → điền nguồn từ bộ khôi phục mẫu. */
async function openDr(p: Page) {
  await p.getByRole('textbox', { name: 'Mã thiết lập' }).fill('demo-2026-itso');
  await p.getByRole('radio', { name: /Khôi phục từ backup/ }).check();
  await p.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(p.getByRole('heading', { name: 'Khôi phục panel từ backup' })).toBeVisible();
  await p.getByLabel('Endpoint').fill('https://s3.ap-southeast-1.example.com');
  await p.getByLabel('Bucket').fill('itso-backup');
  await p.getByLabel('Access key').fill('AKIAITSODEMO');
  await p.getByLabel('Secret key').fill('demo-secret-key');
  await p.getByLabel('Mật khẩu repo panel').fill(data.recovery_kit.repositories[0]?.password ?? '');
  await p.getByLabel('Khóa riêng của panel').fill(data.recovery_kit.panel_private_key);
}

for (const [name, url, act] of PAGES) {
  for (const w of [1440, 390] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${name} ${w} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
        await page.addInitScript((t) => localStorage.setItem('itso.theme', t), theme);
        if (url.startsWith('/admin')) await asPersona(page, 'admin', SA);
        if (url.startsWith('/portal')) await asPersona(page, 'portal', ANPHAT_USER);
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
