// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, setStepMs } from '../db';
import { demoServer } from '../node';

// Prompt 2.8: số liệu nhất quán giữa các trang (dashboard, danh sách, chi tiết, Portal).
const BASE = 'http://demo.local';
const SA = '01938a01-0001-7000-8000-000001000001';
const ANPHAT_USER = '01938a01-0003-7000-8000-000001000003';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const STEP = 5;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function call(method: string, url: string, user = SA, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-User': user,
      ...(url.startsWith('/api/v1/portal') ? { 'X-Demo-Realm': 'portal' } : {}),
      'Idempotency-Key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (res.status === 204 ? undefined : await res.json()) as never };
}
const data = async <T>(url: string, user = SA): Promise<T> =>
  ((await call('GET', url, user)).body as { data: T }).data;
const all = <T>(url: string, user = SA) =>
  data<T[]>(`${url}${url.includes('?') ? '&' : '?'}limit=200`, user);

type Ref = { uuid: string };
type Used = { used: number; limit: number };
type Account = Ref & {
  username: string;
  lifecycle_state: string;
  server: Ref;
  package: Ref;
  usage: Record<'websites' | 'databases' | 'ftp_accounts' | 'cron_jobs', Used> &
    Record<string, unknown>;
};
type Owned = Ref & { hosting_account: Ref };
const countBy = (rows: Owned[], uuid: string) =>
  rows.filter((r) => r.hosting_account.uuid === uuid).length;
const live = (a: Account) => a.lifecycle_state !== 'terminated' && a.lifecycle_state !== 'purged';

beforeAll(() => {
  setStepMs(STEP);
  demoServer.listen({ onUnhandledFrame: 'error' });
});
beforeEach(() => resetDb());
afterAll(() => demoServer.close());

describe('số liệu nhất quán', () => {
  it('dashboard = tổng các danh sách', async () => {
    const d = await data<{
      counts: Record<string, number>;
      package_distribution: { code: string; accounts: number }[];
    }>('/api/v1/admin/dashboard/summary');
    const accounts = await all<Account>('/api/v1/admin/hosting-accounts');
    expect(d.counts.servers).toBe((await all<Ref>('/api/v1/admin/servers')).length);
    expect(d.counts.hosting_accounts).toBe(accounts.filter(live).length);
    expect(d.counts.websites).toBe((await all<Ref>('/api/v1/admin/websites')).length);
    expect(d.counts.databases).toBe((await all<Ref>('/api/v1/admin/databases')).length);
    expect(d.counts.users).toBe((await all<Ref>('/api/v1/admin/users')).length);
    const packages = await all<Ref & { code: string; account_count: number }>(
      '/api/v1/admin/hosting-packages',
    );
    expect(d.counts.packages).toBe(packages.length);
    for (const p of packages) {
      const n = accounts.filter((a) => live(a) && a.package.uuid === p.uuid).length;
      expect(p.account_count, p.code).toBe(n);
      expect(d.package_distribution.find((x) => x.code === p.code)?.accounts).toBe(n);
    }
  });

  it('số account trên server = account đang sống trên server đó', async () => {
    const accounts = await all<Account>('/api/v1/admin/hosting-accounts');
    for (const s of await all<Ref & { name: string; account_count: number }>(
      '/api/v1/admin/servers',
    )) {
      expect(s.account_count, s.name).toBe(
        accounts.filter((a) => live(a) && a.server.uuid === s.uuid).length,
      );
    }
  });

  it('usage của account = số website/database/SFTP/cron trong danh sách', async () => {
    const [accounts, sites, dbs, sftp, cron] = await Promise.all([
      all<Account>('/api/v1/admin/hosting-accounts'),
      all<Owned>('/api/v1/admin/websites'),
      all<Owned>('/api/v1/admin/databases'),
      all<Owned>('/api/v1/admin/sftp-accounts'),
      all<Owned>('/api/v1/admin/cron-jobs'),
    ]);
    for (const a of accounts) {
      expect(a.usage.websites.used, `${a.username} websites`).toBe(countBy(sites, a.uuid));
      expect(a.usage.databases.used, `${a.username} databases`).toBe(countBy(dbs, a.uuid));
      expect(a.usage.ftp_accounts.used, `${a.username} sftp`).toBe(countBy(sftp, a.uuid));
      expect(a.usage.cron_jobs.used, `${a.username} cron`).toBe(countBy(cron, a.uuid));
    }
  });

  it('Portal và Admin thấy cùng usage; số thông báo chưa đọc khớp danh sách', async () => {
    const admin = await data<Account>(`/api/v1/admin/hosting-accounts/${ANPHAT}`);
    const portal = await data<Account>(`/api/v1/portal/hosting-accounts/${ANPHAT}`, ANPHAT_USER);
    const o = await data<{
      accounts: { hosting_account: Ref; usage: unknown }[];
      notifications_unread: number;
    }>('/api/v1/portal/overview', ANPHAT_USER);
    expect(portal.usage).toEqual(admin.usage);
    expect(o.accounts.find((a) => a.hosting_account.uuid === ANPHAT)?.usage).toEqual(admin.usage);
    const notes = await all<{ read_at: string | null }>(
      '/api/v1/portal/notifications',
      ANPHAT_USER,
    );
    expect(o.notifications_unread).toBe(notes.filter((n) => n.read_at === null).length);
  });

  it('tạo website ở Portal → usage, dashboard, danh sách Admin cùng tăng', async () => {
    const before = await data<Account>(`/api/v1/admin/hosting-accounts/${ANPHAT}`);
    const dash = await data<{ counts: { websites: number } }>('/api/v1/admin/dashboard/summary');
    const r = await call('POST', '/api/v1/portal/websites', ANPHAT_USER, {
      hosting_account_uuid: ANPHAT,
      primary_domain: 'blog.anphat.vn',
      type: 'static',
      document_root: 'public',
      ssl_mode: 'none',
      php_version: null,
      proxy_target: null,
    });
    expect(r.status).toBe(202);
    const job = (r.body as { job: { steps: unknown[] } }).job;
    await wait(STEP * (job.steps.length + 3));
    const after = await data<Account>(`/api/v1/admin/hosting-accounts/${ANPHAT}`);
    expect(after.usage.websites.used).toBe(before.usage.websites.used + 1);
    const dash2 = await data<{ counts: { websites: number } }>('/api/v1/admin/dashboard/summary');
    expect(dash2.counts.websites).toBe(dash.counts.websites + 1);
    const portal = await all<Owned & { primary_domain: string }>(
      '/api/v1/portal/websites',
      ANPHAT_USER,
    );
    expect(portal.map((w) => w.primary_domain)).toContain('blog.anphat.vn');
    expect(countBy(portal, ANPHAT)).toBe(after.usage.websites.used);
  });
});
