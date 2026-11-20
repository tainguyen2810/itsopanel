// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../db';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

// Prompt 2.7: Portal chỉ trả dữ liệu của USER đang đăng nhập (account do user sở hữu).
const BASE = 'http://demo.local';
const ANPHAT_USER = '01938a01-0003-7000-8000-000001000003';
const MKT_USER = '01938a01-0004-7000-8000-000001000004';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const OLDSHOP = '01938a05-0004-7000-8000-000005000004';
const MKT = '01938a05-0002-7000-8000-000005000002';
const PENDING01 = '01938a05-000c-7000-8000-00000500000c';
const JOB_ANPHAT = '01938a0f-0001-7000-8000-00000f000001';
const JOB_PENDING01 = '01938a0f-0005-7000-8000-00000f000005';
const P = (p: string) => `/api/v1/portal${p}`;

async function call(method: string, path: string, user: string, body?: unknown) {
  const res = await fetch(BASE + P(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-User': user,
      'X-Demo-Realm': 'portal',
      'Idempotency-Key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = res.status === 204 ? undefined : await res.json();
  return { status: res.status, body: json };
}
const rows = <T>(r: { body: unknown }) => (r.body as { data: T[] }).data;

type Owned = { uuid: string; hosting_account?: { uuid: string } };

beforeAll(() => demoServer.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => resetDb());
afterAll(() => demoServer.close());

describe('Portal: chỉ dữ liệu của user đang đăng nhập', () => {
  it.each([
    [ANPHAT_USER, [ANPHAT, OLDSHOP]],
    [MKT_USER, [MKT, PENDING01]],
  ])('%s chỉ thấy account của mình', async (user, own) => {
    const r = await call('GET', '/hosting-accounts?per_page=100', user);
    expect(r.status).toBe(200);
    expect(validateResponse(P('/hosting-accounts'), 'get', r.status, r.body)).toEqual([]);
    expect(
      rows<Owned>(r)
        .map((a) => a.uuid)
        .sort(),
    ).toEqual([...own].sort());
  });

  it.each([
    '/websites',
    '/databases',
    '/sftp-accounts',
    '/cron-jobs',
    '/backup-snapshots',
    '/restores',
  ])('danh sách %s chỉ gồm tài nguyên thuộc account của mình', async (path) => {
    for (const [user, own] of [
      [ANPHAT_USER, [ANPHAT, OLDSHOP]],
      [MKT_USER, [MKT, PENDING01]],
    ] as const) {
      const r = await call('GET', `${path}?per_page=100`, user);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
      for (const x of rows<Owned>(r)) {
        expect(own).toContain(x.hosting_account?.uuid);
      }
    }
  });

  it('chi tiết account/website/job của người khác → 404, không lộ dữ liệu', async () => {
    const sites = rows<Owned>(await call('GET', '/websites?per_page=100', ANPHAT_USER));
    const site = sites[0]?.uuid ?? 'missing';
    for (const path of [
      `/hosting-accounts/${ANPHAT}`,
      `/hosting-accounts/${ANPHAT}/usage`,
      `/hosting-accounts/${ANPHAT}/features`,
      `/websites/${site}`,
      `/jobs/${JOB_ANPHAT}`,
    ]) {
      expect((await call('GET', path, ANPHAT_USER)).status, path).toBe(200);
      const other = await call('GET', path, MKT_USER);
      expect(other.status, path).toBe(404);
      expect(JSON.stringify(other.body)).not.toContain('anphat');
    }
    expect((await call('GET', `/jobs/${JOB_PENDING01}`, MKT_USER)).status).toBe(200);
  });

  it('job và thông báo theo từng user', async () => {
    const jobs = rows<{ uuid: string }>(await call('GET', '/jobs?per_page=100', MKT_USER));
    expect(jobs.map((j) => j.uuid)).toContain(JOB_PENDING01);
    expect(jobs.map((j) => j.uuid)).not.toContain(JOB_ANPHAT);

    const a = rows<{ uuid: string }>(await call('GET', '/notifications', ANPHAT_USER));
    const m = rows<{ uuid: string }>(await call('GET', '/notifications', MKT_USER));
    const shared = a.filter((x) => m.some((y) => y.uuid === x.uuid));
    expect(shared).toEqual([]);
  });

  it('không tạo website trên account của người khác', async () => {
    const r = await call('POST', '/websites', MKT_USER, {
      hosting_account_uuid: ANPHAT,
      primary_domain: 'lan.anphat.vn',
      type: 'static',
      document_root: 'public',
      ssl_mode: 'none',
      php_version: null,
      proxy_target: null,
    });
    expect([403, 404, 422]).toContain(r.status);
  });

  it('không có endpoint admin trong realm portal', async () => {
    const r = await call('GET', '/servers', ANPHAT_USER);
    expect(r.status).toBe(404);
  });
});
