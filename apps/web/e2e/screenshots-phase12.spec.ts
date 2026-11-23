import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { asPersona, expect, test } from './demo';

// Mockup Phase 12 (Prompt 12.0, trước khi code): import từ panel khác (quét → kế hoạch → báo cáo → cutover), CIS
// trong Bảo mật, Cập nhật hệ thống (journal dở dang), Sẵn sàng production + Gate G1–G8; 1440/390 × light/dark.
// Mặc định ghi vào test-results; `make screenshots` đặt SCREENSHOT_DIR_P12=docs/screenshots/phase-12.
const OUT = process.env.SCREENSHOT_DIR_P12
  ? resolve(process.env.SCREENSHOT_DIR_P12)
  : resolve(import.meta.dirname, '../test-results/screenshots-phase-12');
const SA = '01938a01-0001-7000-8000-000001000001';
const IMP_PLANNED = '01938a3a-0001-7000-8000-00003a000001';
const IMP_PARTIAL = '01938a3a-0002-7000-8000-00003a000002';
const IMP_FAILED = '01938a3a-0003-7000-8000-00003a000003';

type Shot = readonly [name: string, url: string, act?: (p: Page) => Promise<void>];

const PAGES: readonly Shot[] = [
  ['admin-imports', '/admin/imports'],
  [
    'admin-import-scan',
    '/admin/imports',
    async (p) => {
      await p.getByRole('button', { name: 'Quét nguồn' }).click();
      await expect(p.getByRole('dialog', { name: 'Quét panel nguồn' })).toBeVisible();
    },
  ],
  ['admin-import-plan', `/admin/imports/${IMP_PLANNED}`],
  [
    'admin-import-edit',
    `/admin/imports/${IMP_PLANNED}`,
    async (p) => {
      await p.getByRole('button', { name: 'Sửa kế hoạch cho kho.anphatgroup.vn' }).click();
      await expect(p.getByRole('dialog')).toBeVisible();
    },
  ],
  [
    'admin-import-run-confirm',
    `/admin/imports/${IMP_PLANNED}`,
    async (p) => {
      await p.getByRole('button', { name: 'Chạy import' }).click();
      await expect(p.getByRole('alertdialog')).toBeVisible();
    },
  ],
  ['admin-import-report', `/admin/imports/${IMP_PARTIAL}`],
  ['admin-import-scan-failed', `/admin/imports/${IMP_FAILED}`],
  ['admin-security-cis', '/admin/security/cis'],
  ['admin-system-updates', '/admin/system/updates'],
  ['admin-system-readiness', '/admin/system/readiness'],
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
