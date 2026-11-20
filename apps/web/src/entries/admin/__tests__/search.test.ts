import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { resetDb } from '@/demo/db';
import { demoServer } from '@/demo/node';
import { createSearch } from '../search';

const t = ((k: string) => k) as unknown as TFunction<'admin'>;
const AD = '01938a01-0002-7000-8000-000001000002';

beforeAll(() => demoServer.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => {
  resetDb();
  localStorage.clear();
});
afterAll(() => demoServer.close());

describe('Ctrl+K: tìm kiếm admin', () => {
  it('tìm theo username/domain, không phân biệt dấu, tối đa 5 kết quả mỗi nhóm', async () => {
    const groups = await createSearch(t)('anphat');
    const by = Object.fromEntries(groups.map((g) => [g.key, g.hits]));
    expect(by.accounts?.map((h) => h.label)).toContain('anphat');
    expect(by.accounts?.[0]?.href).toMatch(/^\/admin\/hosting-accounts\/[0-9a-f-]{36}$/);
    expect(by.websites?.length).toBeGreaterThan(0);
    expect(by.websites?.every((h) => h.label.includes('anphat'))).toBe(true);
    expect(groups.every((g) => g.hits.length <= 5)).toBe(true);

    const diacritics = await createSearch(t)('quan tri');
    expect(diacritics.find((g) => g.key === 'users')?.hits.length).toBeGreaterThan(0);
  });

  it('ADMIN không tìm người dùng (nhóm users rỗng)', async () => {
    localStorage.setItem('itso.demo.actor.admin', AD);
    const groups = await createSearch(t)('a');
    expect(groups.find((g) => g.key === 'users')?.hits).toEqual([]);
  });
});
