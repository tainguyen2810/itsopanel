import { test as base, expect, type Page } from '@playwright/test';
import data from '../../../contracts/examples/demo-dataset.json' with { type: 'json' };
import type { RouteDef } from '../src/shared/routing/types';

export const DEMO_URL = 'http://127.0.0.1:5174';
export { data };

type Item = { uuid: string };
const first = (k: keyof typeof data) => (data[k] as Item[])[0]?.uuid ?? 'missing';
const anphat = data.accounts.find((a) => a.username === 'anphat');

/** Giá trị $id theo đoạn đường dẫn đứng trước (servers/$id → uuid server mẫu). */
const ADMIN_IDS: Record<string, string> = {
  servers: first('servers'),
  'compose-projects': first('compose'),
  wordpress: first('wordpress'),
  'hosting-packages': first('packages'),
  'hosting-accounts': first('accounts'),
  websites: first('websites'),
  users: first('users'),
  jobs: first('jobs'),
};
const PORTAL_IDS: Record<string, string> = {
  accounts: anphat?.uuid ?? 'missing',
  websites: data.websites.find((w) => w.hosting_account.uuid === anphat?.uuid)?.uuid ?? 'missing',
  jobs: first('jobs'),
  wordpress: data.wordpress.find((w) => w.hosting_account.uuid === anphat?.uuid)?.uuid ?? 'missing',
};

export function urlOf(realm: 'admin' | 'portal', def: RouteDef): string {
  const ids = realm === 'admin' ? ADMIN_IDS : PORTAL_IDS;
  const segs = def.path.split('/');
  const filled = segs.map((s, i) =>
    s.startsWith('$') ? (ids[segs[i - 1] ?? ''] ?? 'missing') : s,
  );
  return `/${realm}${filled.join('/')}`.replace(/\/$/, '/');
}

/** Ghi nhận lỗi console, lỗi trang và request /api trả ≥ 400 trong khi test. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  return errors;
}

export async function asPersona(page: Page, realm: 'admin' | 'portal', uuid: string) {
  await page.addInitScript(([key, id]) => localStorage.setItem(key, id), [
    `itso.demo.actor.${realm}`,
    uuid,
  ] as const);
}

/**
 * baseURL đặt qua fixture (không dùng test.use trong module chung: module chỉ nạp một lần
 * mỗi worker nên test.use chỉ áp cho file spec nạp đầu tiên).
 */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, provide) => {
    await provide(DEMO_URL);
  },
});
export { expect };
