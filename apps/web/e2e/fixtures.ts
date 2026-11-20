import { test as base, type Page } from '@playwright/test';

export const STATUS = {
  api: 'ok',
  database: { ok: true, latency_ms: 1.8, error: null },
  redis: { ok: true, latency_ms: 0.4, error: null },
  agent: { reachable: true, mode: 'mock', version: '0.1.0-mock', latency_ms: 2.1, error: null },
  checked_at: '2026-11-20T08:15:00+07:00',
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
  await page.route('**/api/v1/system/health', (r) =>
    r.fulfill({ json: { data: { status: 'ok' } } }),
  );
  await page.route('**/api/v1/admin/system/status', (r) => r.fulfill({ json: { data: STATUS } }));
}

export const test = base;
export { expect } from '@playwright/test';
