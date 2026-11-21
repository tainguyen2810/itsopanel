import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { asPersona, data, expect, test } from './demo';

// Mockup Phase 9 (Prompt 9.0, trước khi code): nhiều máy chủ & chuyển tài khoản ở chế độ demo, 1440/390 ×
// light/dark: thêm node (token một lần + ghim CA), danh sách server theo vai trò/kênh/kết nối, node mất kết nối
// (banner + job chờ node), kênh mTLS + chứng chỉ, thu hồi node, gợi ý server kèm lý do loại, chuyển account
// (kiểm tra trước → kiểm tra dữ liệu → cutover có DNS → giữ nguồn), khôi phục sang server khác.
// Mặc định ghi vào test-results; `make screenshots` đặt SCREENSHOT_DIR_P9=docs/screenshots/phase-9.
const OUT = process.env.SCREENSHOT_DIR_P9
  ? resolve(process.env.SCREENSHOT_DIR_P9)
  : resolve(import.meta.dirname, '../test-results/screenshots-phase-9');
const SA = '01938a01-0001-7000-8000-000001000001';
const byName = (n: string) => data.servers.find((s) => s.name === n)?.uuid ?? 'missing';
const acc = (u: string) => data.accounts.find((a) => a.username === u)?.uuid ?? 'missing';
const snap = data.snapshots[0]?.uuid ?? 'missing';

type Shot = readonly [name: string, url: string, act?: (p: Page) => Promise<void>];

const PAGES: readonly Shot[] = [
  ['admin-servers', '/admin/servers'],
  [
    'admin-server-new-token',
    '/admin/servers/new',
    async (p) => {
      await p.getByLabel('Tên').fill('srv-hcm-02');
      await p.getByRole('button', { name: 'Tạo token đăng ký' }).click();
      await expect(p.getByText(/--ca-sha256 [0-9a-f]{64}/)).toBeVisible();
    },
  ],
  [
    'admin-server-channel',
    `/admin/servers/${byName('srv-hn-02')}`,
    async (p) => {
      await p.getByRole('tab', { name: 'Agent' }).click();
      await expect(p.getByText('Kênh kết nối agent')).toBeVisible();
    },
  ],
  [
    'admin-server-unreachable',
    `/admin/servers/${byName('srv-hcm-01')}`,
    async (p) => {
      await expect(p.getByText('srv-hcm-01 mất kết nối')).toBeVisible();
    },
  ],
  [
    'admin-server-revoke',
    `/admin/servers/${byName('srv-hn-02')}`,
    async (p) => {
      await p.getByRole('button', { name: 'Thu hồi node' }).click();
      await expect(p.getByRole('alertdialog', { name: /Thu hồi srv-hn-02/ })).toBeVisible();
    },
  ],
  ['admin-jobs-waiting', '/admin/jobs?state=waiting_agent'],
  [
    'admin-account-placement',
    '/admin/hosting-accounts/new',
    async (p) => {
      const next = p.getByRole('button', { name: 'Tiếp' });
      await p.getByRole('combobox', { name: 'Chủ sở hữu' }).click();
      await p.getByRole('option', { name: /Phòng Marketing/ }).click();
      await next.click();
      await p.getByRole('radio', { name: /Basic/ }).check();
      await next.click();
      await expect(p.getByText('Không đủ điều kiện')).toBeVisible();
    },
  ],
  [
    'admin-migrate-preflight',
    `/admin/hosting-accounts/${acc('saomai')}/migrate`,
    async (p) => {
      await p.getByRole('radio', { name: /srv-hn-01/ }).check();
      await p.getByRole('button', { name: 'Kiểm tra trước' }).click();
      await expect(p.getByText(/Kết quả kiểm tra với srv-hn-01/)).toBeVisible();
    },
  ],
  ['admin-migrate-verify', `/admin/hosting-accounts/${acc('lehoa')}/migrate`],
  [
    'admin-migrate-cutover',
    `/admin/hosting-accounts/${acc('lehoa')}/migrate`,
    async (p) => {
      await p.getByRole('button', { name: 'Cutover' }).click();
      await expect(p.getByRole('alertdialog', { name: /Cutover sang srv-hn-02/ })).toBeVisible();
    },
  ],
  [
    'admin-migrate-holding',
    `/admin/hosting-accounts/${acc('lehoa')}/migrate`,
    async (p) => {
      await p.getByRole('button', { name: 'Cutover' }).click();
      const dlg = p.getByRole('alertdialog', { name: /Cutover sang srv-hn-02/ });
      await dlg.getByRole('textbox').fill('lehoa');
      await dlg.getByRole('button', { name: 'Cutover' }).click();
      await expect(p.getByText('Đã xong: Cutover chuyển máy chủ')).toBeVisible({
        timeout: 15_000,
      });
      await p.keyboard.press('Escape');
      await expect(p.getByText('Account đang chạy ở srv-hn-02')).toBeVisible();
    },
  ],
  [
    'admin-restore-other-server',
    `/admin/restores/new?snapshot=${snap}`,
    async (p) => {
      await p.getByRole('button', { name: 'Tiếp' }).click();
      await p.getByRole('checkbox', { name: /anphat_shop/ }).check();
      await p.getByRole('button', { name: 'Tiếp' }).click();
      await p.getByRole('combobox', { name: 'Máy chủ đích' }).click();
      await p.getByRole('option', { name: 'srv-hn-02' }).click();
    },
  ],
];

for (const [name, url, act] of PAGES) {
  for (const w of [1440, 390] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${name} ${w} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
        await page.addInitScript((t) => localStorage.setItem('itso.theme', t), theme);
        await asPersona(page, 'admin', SA);
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
