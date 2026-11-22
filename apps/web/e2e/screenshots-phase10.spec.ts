import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { asPersona, data, expect, test } from './demo';

// Mockup Phase 10 (Prompt 10.0, trước khi code): Software Manager, Docker Manager, WordPress Toolkit ở chế độ
// demo, 1440/390 × light/dark: catalog phần mềm + tự cập nhật OS, Docker host (kiểm tra an toàn, firewall
// DOCKER-USER), bật Docker, volume, compose (validator + override SA, revision diff, cập nhật image có rollback),
// gắn domain cho service, registry, WordPress (cập nhật chọn lọc có lịch sử, hardening, staging, Portal).
// Mặc định ghi vào test-results; `make screenshots` đặt SCREENSHOT_DIR_P10=docs/screenshots/phase-10.
const OUT = process.env.SCREENSHOT_DIR_P10
  ? resolve(process.env.SCREENSHOT_DIR_P10)
  : resolve(import.meta.dirname, '../test-results/screenshots-phase-10');
const SA = '01938a01-0001-7000-8000-000001000001';
const byName = (n: string) => data.servers.find((s) => s.name === n)?.uuid ?? 'missing';
const compose = (n: string) => data.compose.find((c) => c.name === n)?.uuid ?? 'missing';
const WP = data.wordpress[0]?.uuid ?? 'missing';
const anphat = data.accounts.find((a) => a.username === 'anphat')?.uuid;
const WP_PORTAL = data.wordpress.find((w) => w.hosting_account.uuid === anphat)?.uuid ?? 'missing';
const S1 = byName('srv-hn-01');

type Shot = readonly [
  name: string,
  url: string,
  act?: ((p: Page) => Promise<void>) | undefined,
  realm?: 'admin' | 'portal',
];

const BAD_YAML =
  'services:\n  app:\n    image: nginx:1.27\n    privileged: true\n    ports:\n      - "8080:80"\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n';

const PAGES: readonly Shot[] = [
  ['admin-software', `/admin/servers/${S1}/software`],
  ['admin-docker-host', `/admin/servers/${S1}/docker`],
  [
    'admin-docker-enable',
    `/admin/servers/${byName('srv-hn-02')}/docker`,
    async (p) => {
      await expect(p.getByRole('button', { name: 'Bật Docker' })).toBeVisible();
    },
  ],
  [
    'admin-docker-volumes',
    `/admin/servers/${S1}/docker?tab=volumes`,
    async (p) => {
      await expect(p.getByText('old-test-data').filter({ visible: true }).first()).toBeVisible();
    },
  ],
  ['admin-compose-list', '/admin/compose-projects'],
  [
    'admin-compose-validate',
    '/admin/compose-projects',
    async (p) => {
      await p.getByRole('button', { name: 'Tạo project' }).click();
      const dlg = p.getByRole('dialog', { name: 'Tạo compose project' });
      await dlg.getByRole('combobox', { name: 'Máy chủ' }).click();
      await p.getByRole('option', { name: 'srv-hn-01' }).click();
      await dlg.getByLabel('Tên project').fill('thu-nghiem');
      await dlg.getByLabel('compose.yaml').fill(BAD_YAML);
      await dlg.getByRole('button', { name: 'Kiểm tra', exact: true }).click();
      await expect(dlg.getByText(/lỗi chặn triển khai/)).toBeVisible();
    },
  ],
  [
    'admin-compose-detail',
    `/admin/compose-projects/${compose('bi')}`,
    async (p) => {
      await expect(p.getByText(/đã tự quay lại/)).toBeVisible();
    },
  ],
  [
    'admin-compose-override',
    `/admin/compose-projects/${compose('status')}?tab=validation`,
    async (p) => {
      await expect(p.getByText('Đã ghi đè').first()).toBeVisible();
    },
  ],
  [
    'admin-compose-revisions',
    `/admin/compose-projects/${compose('cache')}?tab=revisions`,
    async (p) => {
      await expect(p.getByText(/Khác biệt r2 → r3/).first()).toBeVisible();
    },
  ],
  [
    'admin-website-docker',
    `/admin/websites?new=docker&project=${compose('status')}`,
    async (p) => {
      await expect(p.getByRole('dialog', { name: 'Thêm website' })).toBeVisible();
    },
  ],
  ['admin-registries', '/admin/docker/registries'],
  ['admin-wordpress', '/admin/wordpress'],
  [
    'admin-wordpress-detail',
    `/admin/wordpress/${WP}`,
    async (p) => {
      await expect(p.getByText('Lần cập nhật gần nhất đã tự quay lại')).toBeVisible();
    },
  ],
  [
    'admin-wordpress-updates',
    `/admin/wordpress/${WP}?tab=updates`,
    async (p) => {
      await p.getByRole('button', { name: 'Chọn mọi bản mới' }).click();
      await expect(p.getByText('Lịch sử cập nhật')).toBeVisible();
    },
  ],
  ['admin-wordpress-security', `/admin/wordpress/${WP}?tab=security`],
  [
    'admin-wordpress-staging',
    `/admin/wordpress/${WP}`,
    async (p) => {
      await p.getByRole('button', { name: 'Tạo bản staging' }).click();
      await expect(p.getByRole('dialog', { name: /Tạo staging cho/ })).toBeVisible();
    },
  ],
  ['portal-wordpress-detail', `/portal/wordpress/${WP_PORTAL}?tab=updates`, undefined, 'portal'],
];

for (const [name, url, act, realm = 'admin'] of PAGES) {
  for (const w of [1440, 390] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${name} ${w} ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
        await page.addInitScript((t) => localStorage.setItem('itso.theme', t), theme);
        if (realm === 'admin') await asPersona(page, 'admin', SA);
        await page.goto(url);
        // Trang mở sẵn hộp thoại (?new=docker) ẩn h1 khỏi cây truy cập.
        await expect(
          page.getByRole('heading', { level: 1 }).or(page.getByRole('dialog')),
        ).toBeVisible();
        await page.waitForLoadState('networkidle');
        if (act) await act(page);
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
        await page.screenshot({ path: `${OUT}/${name}-${w}-${theme}.png`, animations: 'disabled' });
      });
    }
  }
}
