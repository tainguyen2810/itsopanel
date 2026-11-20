// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../dataset';
import { resetDb } from '../db';
import { demoServer } from '../node';
import { registeredRoutes } from '../router';
import { hasOperation, validateResponse } from './openapi';

const D = dataset as unknown as Record<string, { uuid: string }[]>;
const first = (k: string) => D[k]?.[0]?.uuid ?? 'missing';

/** Tham số mẫu cho {id} theo đoạn đường dẫn đứng trước. */
const ID_BY_SEGMENT: Record<string, string> = {
  servers: first('servers'),
  'hosting-accounts': first('accounts'),
  'hosting-packages': first('packages'),
  websites: first('websites'),
  databases: first('databases'),
  jobs: first('jobs'),
  users: first('users'),
  'backup-destinations': first('backup_dests'),
  'backup-policies': first('backup_policies'),
  restores: first('restores'),
  'account-migrations': first('migrations'),
  'compose-projects': first('compose'),
  'alert-rules': first('alert_rules'),
  zones: first('dns_zones'),
  'cron-jobs': first('cron'),
  'git-repositories': first('git_repositories'),
  'backup-snapshots': first('snapshots'),
};
const OTHER: Record<string, string> = {
  group: 'general',
  container: (dataset.containers as { id: string }[])[0]?.id ?? 'missing',
};
/** Tham số query bắt buộc theo contract. */
const QUERY: Record<string, string> = {
  '/api/v1/admin/metrics/servers/{id}': '?metric=cpu_pct&range=24h',
  '/api/v1/admin/metrics/hosting-accounts/{id}': '?metric=ram_pct&range=7d',
  '/api/v1/admin/hosting-accounts/{id}/files': '?path=.',
  '/api/v1/admin/hosting-accounts/{id}/files/content': '?path=sites/anphat.vn/public/index.php',
  '/api/v1/admin/hosting-accounts/{id}/files/download': '?path=sites/anphat.vn/public/index.php',
  '/api/v1/admin/websites/{id}/logs': '?kind=access',
  '/api/v1/admin/backup-snapshots/{id}/browse': '?path=.',
};

function urlFor(path: string): string {
  return path.replace(/\{(\w+)\}/g, (_, k: string, offset: number) => {
    if (k === 'id') {
      const seg = path.slice(0, offset).split('/').filter(Boolean).at(-1) ?? '';
      return ID_BY_SEGMENT[seg] ?? 'missing';
    }
    return OTHER[k] ?? 'missing';
  });
}

beforeAll(() => demoServer.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => resetDb());
afterAll(() => demoServer.close());

describe('API giả lập (MSW) đúng theo OpenAPI', () => {
  const routes = registeredRoutes();

  it('mọi handler đăng ký đều là operation có trong OpenAPI', () => {
    const missing = routes.filter((r) => !hasOperation(r.path, r.method));
    expect(missing).toEqual([]);
    expect(routes.length).toBeGreaterThan(60);
  });

  it.each(routes.filter((r) => r.method === 'get').map((r) => [r.path, r] as const))(
    'GET %s trả body hợp lệ theo schema',
    async (_p, r) => {
      const res = await fetch(`http://demo.local${urlFor(r.path)}${QUERY[r.path] ?? ''}`);
      if (res.headers.get('Content-Type')?.startsWith('text/csv')) {
        // Xuất CSV (audit log): contract khai báo text/csv, kiểm dòng tiêu đề.
        expect(res.status).toBe(200);
        expect((await res.text()).split('\n')[0]).toMatch(/^at,actor,/);
        return;
      }
      const body: unknown = res.status === 204 ? undefined : await res.json();
      expect(res.status, JSON.stringify(body)).toBeLessThan(300);
      expect(validateResponse(r.path, r.method, res.status, body)).toEqual([]);
    },
  );

  it('phân trang bằng cursor, lọc và tìm kiếm theo tham số contract', async () => {
    const all = (await (
      await fetch('http://demo.local/api/v1/admin/websites?limit=200')
    ).json()) as {
      data: unknown[];
    };
    expect(all.data).toHaveLength(dataset.websites.length);
    const p1 = (await (await fetch('http://demo.local/api/v1/admin/websites?limit=5')).json()) as {
      data: unknown[];
      meta: { next_cursor: string };
    };
    expect(p1.data).toHaveLength(5);
    const p2 = (await (
      await fetch(`http://demo.local/api/v1/admin/websites?limit=5&cursor=${p1.meta.next_cursor}`)
    ).json()) as { data: { uuid: string }[] };
    expect(p2.data[0]).not.toEqual(p1.data[0]);
    const q = (await (await fetch('http://demo.local/api/v1/admin/websites?q=anphat')).json()) as {
      data: { primary_domain: string }[];
    };
    expect(q.data.length).toBeGreaterThan(0);
    expect(q.data.every((w) => w.primary_domain.includes('anphat'))).toBe(true);
    const bad = await fetch('http://demo.local/api/v1/admin/websites?limit=999');
    expect(bad.status).toBe(422);
    expect(validateResponse('/api/v1/admin/websites', 'get', 422, await bad.json())).toEqual([]);
  });

  it('ADMIN chỉ thấy phạm vi được giao; ngoài phạm vi trả 404', async () => {
    const minh = dataset.users.find((u) => u.role === 'ADMIN');
    const headers = { 'X-Demo-User': minh?.uuid ?? '' };
    const res = (await (
      await fetch('http://demo.local/api/v1/admin/hosting-accounts', { headers })
    ).json()) as {
      data: { username: string; server: { name: string } }[];
    };
    const names = res.data.map((a) => a.username);
    // Phạm vi: server srv-hn-01 (mọi account trên đó) + riêng account lehoa.
    expect(names).toContain('lehoa');
    expect(res.data.every((a) => a.server.name === 'srv-hn-01' || a.username === 'lehoa')).toBe(
      true,
    );
    const outside = dataset.accounts.find((a) => a.server.name === 'srv-hn-02');
    const r404 = await fetch(`http://demo.local/api/v1/admin/hosting-accounts/${outside?.uuid}`, {
      headers,
    });
    expect(r404.status).toBe(404);
  });
});
