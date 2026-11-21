import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { asPersona, data, expect, test } from './demo';

// Mockup Phase 7 (Prompt 7.0, trước khi code): Security Center ở chế độ demo, 1440/390 × light/dark, gồm trạng thái
// quan trọng (chống tự khóa tường lửa, đếm ngược xác nhận SSH, CAPTCHA, policy root tắt, phát lại phiên, cách ly).
// Mặc định ghi vào test-results; `make screenshots` đặt SCREENSHOT_DIR_P7=docs/screenshots/phase-7.
const OUT = process.env.SCREENSHOT_DIR_P7
  ? resolve(process.env.SCREENSHOT_DIR_P7)
  : resolve(import.meta.dirname, '../test-results/screenshots-phase-7');
const SA = '01938a01-0001-7000-8000-000001000001';
const server = data.servers[0]?.uuid ?? 'missing';

type Shot = readonly [name: string, url: string, act?: (p: Page) => Promise<void>];

const PAGES: readonly Shot[] = [
  ['admin-security', '/admin/security'],
  ['admin-firewall', `/admin/servers/${server}/firewall`],
  [
    'admin-firewall-lockout',
    `/admin/servers/${server}/firewall`,
    async (p) => {
      await p.getByRole('button', { name: 'Thêm rule' }).click();
      const dlg = p.getByRole('dialog');
      await dlg.getByLabel('Ưu tiên').fill('5');
      await dlg.getByRole('combobox', { name: 'Hành động' }).click();
      await p.getByRole('option', { name: 'Chặn' }).click();
      await dlg.getByLabel('Cổng').fill('22');
      await dlg.getByLabel('Nguồn').fill('0.0.0.0/0');
      await dlg.getByRole('button', { name: 'Lưu' }).click();
      await expect(dlg.getByText(/từ IP hiện tại của bạn/)).toBeVisible();
    },
  ],
  [
    'admin-firewall-confirm',
    `/admin/servers/${server}/firewall`,
    async (p) => {
      await p.getByRole('button', { name: 'Thêm rule' }).click();
      const dlg = p.getByRole('dialog');
      await dlg.getByLabel('Ưu tiên').fill('40');
      await dlg.getByRole('combobox', { name: 'Hành động' }).click();
      await p.getByRole('option', { name: 'Chặn' }).click();
      await dlg.getByLabel('Cổng').fill('3306');
      await dlg.getByLabel('Nguồn').fill('0.0.0.0/0');
      await dlg.getByRole('button', { name: 'Lưu' }).click();
      await expect(dlg).toBeHidden();
      await p.getByRole('button', { name: 'Áp dụng' }).click();
      await p.getByRole('dialog').getByRole('button', { name: 'Áp dụng' }).click();
      await stepUp(p);
      await expect(p.getByTestId('firewall-countdown')).toBeVisible({ timeout: 15_000 });
    },
  ],
  [
    'admin-ssh-confirm',
    '/admin/security/ssh',
    async (p) => {
      await p.getByLabel('Số lần thử tối đa').fill('4');
      await p.getByRole('button', { name: 'Áp dụng' }).click();
      await stepUp(p);
      await expect(p.getByTestId('ssh-countdown')).toBeVisible({ timeout: 15_000 });
    },
  ],
  ['admin-fail2ban', '/admin/security/fail2ban'],
  ['admin-waf', '/admin/security/waf'],
  ['admin-malware', '/admin/security/malware'],
  ['admin-fim', '/admin/security/fim'],
  ['admin-allowlist', '/admin/security/allowlist'],
  ['admin-terminal-sessions', '/admin/security/terminal'],
  [
    'admin-terminal-playback',
    '/admin/security/terminal',
    async (p) => {
      await p.getByRole('button', { name: 'Xem lại' }).first().click();
      await stepUp(p);
      await expect(p.getByRole('log').getByText('table inet itso')).toBeVisible({
        timeout: 15_000,
      });
    },
  ],
  [
    'admin-terminal-root-off',
    `/admin/servers/${server}/terminal`,
    async (p) => {
      await p.getByRole('combobox', { name: 'Chế độ' }).click();
      await p.getByRole('option', { name: /root/i }).click();
      await expect(p.getByText('Policy máy chủ đang tắt terminal root')).toBeVisible();
    },
  ],
  ['admin-settings-login', '/admin/settings?tab=security'],
  [
    'admin-login-captcha',
    '/admin/login',
    async (p) => {
      await p.getByLabel('Mật khẩu').fill('wrong-password');
      for (let i = 0; i < 4; i++) await p.getByRole('button', { name: 'Đăng nhập' }).click();
      await expect(p.getByTestId('captcha')).toHaveAttribute('data-state', 'solved', {
        timeout: 15_000,
      });
    },
  ],
  ['portal-security', '/portal/security'],
  [
    'portal-login-captcha',
    '/portal/login',
    async (p) => {
      await p.getByLabel('Mật khẩu').fill('wrong-password');
      for (let i = 0; i < 4; i++) await p.getByRole('button', { name: 'Đăng nhập' }).click();
      await expect(p.getByTestId('captcha')).toHaveAttribute('data-state', 'solved', {
        timeout: 15_000,
      });
    },
  ],
];

/** Hộp thoại step-up MFA chung (demo: mã 6 số bất kỳ khác 000000). */
async function stepUp(p: Page) {
  const dlg = p.getByRole('dialog', { name: /Xác thực lại/ });
  if (await dlg.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await dlg.getByRole('textbox').fill('123456');
    await dlg.getByRole('button', { name: /Xác (nhận|thực)/ }).click();
  }
}

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
