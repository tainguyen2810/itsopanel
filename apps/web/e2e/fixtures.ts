import { test as base, type Page } from '@playwright/test';
import data from '../../../contracts/examples/demo-dataset.json' with { type: 'json' };

const anphat = data.accounts.find((a) => a.username === 'anphat');
/** Tổng quan Portal mẫu (shell Portal ở build thường, không có MSW). */
export const PORTAL_OVERVIEW = {
  accounts: anphat
    ? [
        {
          hosting_account: { uuid: anphat.uuid, username: anphat.username },
          lifecycle_state: anphat.lifecycle_state,
          usage: anphat.usage,
        },
      ]
    : [],
  warnings: [],
  recent_jobs: data.jobs
    .slice(0, 3)
    .map((j) => ({ uuid: j.uuid, type: j.type, state: j.state, progress: j.progress })),
  notifications_unread: 1,
};

export const STATUS = {
  api: 'ok',
  database: { ok: true, latency_ms: 1.8, error: null },
  redis: { ok: true, latency_ms: 0.4, error: null },
  agent: { reachable: true, mode: 'mock', version: '0.1.0-mock', latency_ms: 2.1, error: null },
  checked_at: '2026-11-20T08:15:00+07:00',
};

const ME = {
  admin: {
    uuid: '01938a01-0001-7000-8000-000001000001',
    name: 'Quản trị hệ thống',
    email: 'superadmin@itso.local',
    role: 'SUPER_ADMIN',
    mfa_enabled: true,
  },
  portal: {
    uuid: '01938a01-0003-7000-8000-000001000003',
    name: 'Công ty An Phát',
    email: 'it@anphat.vn',
    role: 'USER',
    mfa_enabled: false,
  },
};

/** Giả lập API (không cần Laravel) và chọn theme/ngôn ngữ trước khi trang tải. */
export async function prepare(page: Page, opts: { theme: 'light' | 'dark'; lang?: 'vi' | 'en' }) {
  await page.addInitScript(
    ([theme, lang]) => {
      // Chỉ đặt ở lần tải đầu, để test "tải lại vẫn giữ lựa chọn" không bị ghi đè.
      if (sessionStorage.getItem('e2e.seeded')) return;
      sessionStorage.setItem('e2e.seeded', '1');
      localStorage.setItem('itso.theme', theme);
      localStorage.setItem('itso.lang', lang);
    },
    [opts.theme, opts.lang ?? 'vi'] as const,
  );
  // Build thường dùng phiên thật (/auth/me): giả lập người đã đăng nhập + đã xác minh MFA theo realm.
  // Route khác chưa giả lập trả 404 not_available (không gọi tới Laravel đang chạy, nếu có).
  await page.route('**/api/v1/**', (r) =>
    r.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      json: {
        type: 'https://docs.itso.local/errors/not_available',
        title: 'Chưa có ở phiên bản này',
        status: 404,
        code: 'not_found',
      },
    }),
  );
  await page.route('**/api/v1/auth/me', (r) => {
    const realm = r.request().headers()['x-itso-realm'] === 'portal' ? 'portal' : 'admin';
    return r.fulfill({
      json: { data: { user: ME[realm], mfa_verified_at: '2026-11-20T08:00:00+07:00' } },
    });
  });
  await page.route('**/api/v1/system/health', (r) =>
    r.fulfill({ json: { data: { status: 'ok' } } }),
  );
  await page.route('**/api/v1/admin/system/status', (r) => r.fulfill({ json: { data: STATUS } }));
  await page.route('**/api/v1/portal/overview', (r) =>
    r.fulfill({ json: { data: PORTAL_OVERVIEW } }),
  );
  await page.route('**/api/v1/portal/notifications?*', (r) =>
    r.fulfill({ json: { data: [], meta: { page: 1, per_page: 200, total: 0 } } }),
  );
}

export const test = base;
export { expect } from '@playwright/test';
