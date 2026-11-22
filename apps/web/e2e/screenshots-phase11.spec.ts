import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { asPersona, expect, test } from './demo';

// Mockup Phase 11 (Prompt 11.0, trước khi code): Monitoring, Uptime, Alerts, kênh thông báo và tùy chọn
// thông báo ở chế độ demo, 1440/390 × light/dark: tổng quan theo nhóm biểu đồ (server offline), tài nguyên
// theo account (cgroup), uptime theo website (kết quả, chứng chỉ), cảnh báo (ack/silence, quy tắc mặc định,
// xem trước), kênh email/Telegram/webhook (SSRF guard), nhật ký gửi, Dashboard, Portal.
// Mặc định ghi vào test-results; `make screenshots` đặt SCREENSHOT_DIR_P11=docs/screenshots/phase-11.
const OUT = process.env.SCREENSHOT_DIR_P11
  ? resolve(process.env.SCREENSHOT_DIR_P11)
  : resolve(import.meta.dirname, '../test-results/screenshots-phase-11');
const SA = '01938a01-0001-7000-8000-000001000001';

type Shot = readonly [
  name: string,
  url: string,
  act?: ((p: Page) => Promise<void>) | undefined,
  realm?: 'admin' | 'portal',
];

const PAGES: readonly Shot[] = [
  ['admin-dashboard-alerts', '/admin/dashboard'],
  ['admin-monitoring', '/admin/monitoring'],
  [
    'admin-monitoring-offline',
    '/admin/monitoring',
    async (p) => {
      await p.getByRole('combobox', { name: 'Máy chủ' }).first().click();
      await p.getByRole('option', { name: 'srv-hcm-01' }).click();
      await expect(p.getByText(/không gửi số liệu/)).toBeVisible();
    },
  ],
  ['admin-monitoring-accounts', '/admin/monitoring/accounts'],
  [
    'admin-account-chart',
    '/admin/monitoring/accounts',
    async (p) => {
      await p
        .getByRole('button', { name: /^Biểu đồ tài nguyên của/ })
        .first()
        .click();
      await expect(p.getByRole('dialog')).toBeVisible();
    },
  ],
  ['admin-uptime', '/admin/monitoring/uptime'],
  [
    'admin-uptime-results',
    '/admin/monitoring/uptime',
    async (p) => {
      await p
        .getByRole('button', { name: /^Thao tác cho kiểm tra/ })
        .first()
        .click();
      await p.getByRole('menuitem', { name: 'Kết quả' }).click();
      await expect(p.getByRole('dialog')).toBeVisible();
    },
  ],
  [
    'admin-uptime-form',
    '/admin/monitoring/uptime',
    async (p) => {
      await p.getByRole('button', { name: 'Thêm kiểm tra' }).click();
      const dlg = p.getByRole('dialog', { name: 'Thêm kiểm tra' });
      await dlg.getByLabel('Đường dẫn').fill('https://evil.example/');
      await dlg.getByRole('button', { name: 'Lưu' }).click();
      await expect(dlg.getByText(/phải bắt đầu bằng \//)).toBeVisible();
    },
  ],
  ['admin-alerts', '/admin/monitoring/alerts'],
  [
    'admin-alert-silence',
    '/admin/monitoring/alerts',
    async (p) => {
      await p
        .getByRole('button', { name: /^Thao tác cho cảnh báo/ })
        .first()
        .click();
      await expect(p.getByRole('menuitem').first()).toBeVisible();
    },
  ],
  [
    'admin-alert-rule-default',
    '/admin/monitoring/alerts',
    async (p) => {
      await p.getByRole('button', { name: /^Thao tác cho luật Server mất kết nối/ }).click();
      await p.getByRole('menuitem', { name: 'Sửa' }).click();
      const dlg = p.getByRole('dialog');
      await expect(dlg.getByText(/Luật mặc định/)).toBeVisible();
      await dlg.getByRole('button', { name: 'Xem trước' }).click();
      await expect(dlg.getByText(/sẽ cảnh báo ngay/)).toBeVisible();
    },
  ],
  ['admin-channels', '/admin/monitoring/channels'],
  [
    'admin-channel-webhook',
    '/admin/monitoring/channels',
    async (p) => {
      await p.getByRole('button', { name: 'Thêm kênh' }).click();
      const dlg = p.getByRole('dialog', { name: 'Thêm kênh' });
      await dlg.getByLabel('URL webhook').fill('http://10.0.0.8/hook');
      await dlg.getByRole('switch', { name: 'Cho phép mạng nội bộ' }).click();
      await expect(dlg.getByText(/có thể gọi vào dịch vụ nội bộ/)).toBeVisible();
    },
  ],
  [
    'admin-channel-test',
    '/admin/monitoring/channels',
    async (p) => {
      await p.getByRole('button', { name: /^Thao tác cho kênh .*Mattermost/ }).click();
      await p.getByRole('menuitem', { name: 'Gửi thử' }).click();
      await expect(p.getByText(/Gửi thử tới .* lỗi/)).toBeVisible();
    },
  ],
  ['admin-deliveries', '/admin/monitoring/deliveries'],
  ['admin-notification-prefs', '/admin/notifications'],
  ['portal-monitoring', '/portal/monitoring', undefined, 'portal'],
  [
    'portal-uptime-results',
    '/portal/monitoring',
    async (p) => {
      await p.getByRole('button', { name: 'Kết quả' }).first().click();
      await expect(p.getByRole('dialog')).toBeVisible();
    },
    'portal',
  ],
  ['portal-notification-prefs', '/portal/notifications', undefined, 'portal'],
];

for (const [name, url, act, realm = 'admin'] of PAGES) {
  for (const w of [1440, 390] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${name} ${w} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
        await page.addInitScript((t) => localStorage.setItem('itso.theme', t), theme);
        if (realm === 'admin') await asPersona(page, 'admin', SA);
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
