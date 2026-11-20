// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../dataset';
import { resetDb, setStepMs } from '../db';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

const BASE = 'http://demo.local';
const SA = dataset.users.find((u) => u.role === 'SUPER_ADMIN')?.uuid ?? '';
const MINH = dataset.users.find((u) => u.role === 'ADMIN')?.uuid ?? '';
const failedJob = dataset.jobs.find((j) => j.state === 'failed');
const runningJob = dataset.jobs.find((j) => j.state === 'running');
const doneJob = dataset.jobs.find((j) => j.state === 'succeeded');

async function call(method: string, url: string, body?: unknown, user = SA) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-User': user,
      'Idempotency-Key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = res.status === 204 ? undefined : await res.json();
  return { status: res.status, body: json };
}

beforeAll(() => {
  setStepMs(20);
  demoServer.listen({ onUnhandledFrame: 'error' });
});
beforeEach(() => resetDb());
afterAll(() => {
  demoServer.close();
  setStepMs(900);
});

/** [method, template OpenAPI, url, body, status mong đợi] */
const CASES: [string, string, string, unknown, number][] = [
  [
    'post',
    '/api/v1/auth/login',
    '/api/v1/auth/login',
    { email: 'a@itso.local', password: 'x' },
    200,
  ],
  ['post', '/api/v1/auth/login', '/api/v1/auth/login', { email: 'a@itso.local' }, 422],
  [
    'post',
    '/api/v1/auth/mfa/verify',
    '/api/v1/auth/mfa/verify',
    { code: '123456', method: 'totp' },
    200,
  ],
  [
    'post',
    '/api/v1/auth/mfa/verify',
    '/api/v1/auth/mfa/verify',
    { code: '000000', method: 'totp' },
    422,
  ],
  ['post', '/api/v1/auth/step-up', '/api/v1/auth/step-up', { code: '123456', method: 'totp' }, 200],
  ['post', '/api/v1/auth/logout', '/api/v1/auth/logout', undefined, 204],
  [
    'post',
    '/api/v1/auth/password:change',
    '/api/v1/auth/password:change',
    { current_password: 'a', new_password: 'mat-khau-dai-hon-12' },
    204,
  ],
  [
    'post',
    '/api/v1/auth/password:change',
    '/api/v1/auth/password:change',
    { current_password: 'a', new_password: 'ngan' },
    422,
  ],
  ['post', '/api/v1/auth/mfa/totp:enroll', '/api/v1/auth/mfa/totp:enroll', undefined, 200],
  [
    'post',
    '/api/v1/auth/mfa/totp:confirm',
    '/api/v1/auth/mfa/totp:confirm',
    { code: '654321', method: 'totp' },
    204,
  ],
  [
    'delete',
    '/api/v1/auth/sessions/{id}',
    `/api/v1/auth/sessions/${dataset.sessions[1]?.uuid}`,
    undefined,
    204,
  ],
  [
    'delete',
    '/api/v1/auth/sessions/{id}',
    `/api/v1/auth/sessions/${dataset.sessions[0]?.uuid}`,
    undefined,
    409,
  ],
  [
    'post',
    '/api/v1/admin/jobs/{id}:cancel',
    `/api/v1/admin/jobs/${runningJob?.uuid}:cancel`,
    undefined,
    200,
  ],
  [
    'post',
    '/api/v1/admin/jobs/{id}:cancel',
    `/api/v1/admin/jobs/${doneJob?.uuid}:cancel`,
    undefined,
    409,
  ],
  [
    'post',
    '/api/v1/admin/jobs/{id}:retry',
    `/api/v1/admin/jobs/${failedJob?.uuid}:retry`,
    undefined,
    202,
  ],
  [
    'post',
    '/api/v1/admin/jobs/{id}:retry',
    `/api/v1/admin/jobs/${doneJob?.uuid}:retry`,
    undefined,
    409,
  ],
];

describe('thao tác ghi của API giả lập đúng theo OpenAPI', () => {
  it.each(CASES)('%s %s → %s', async (method, template, url, body, status) => {
    const r = await call(method.toUpperCase(), url, body);
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    expect(validateResponse(template, method, r.status, r.body)).toEqual([]);
  });

  it('chạy lại job: job mới chạy từng bước tới khi xong, có audit', async () => {
    const r = await call('POST', `/api/v1/admin/jobs/${failedJob?.uuid}:retry`);
    const job = (r.body as { job: { uuid: string; steps: unknown[] } }).job;
    expect(job.steps.length).toBeGreaterThan(0);
    await new Promise((ok) => setTimeout(ok, 20 * (job.steps.length + 2)));
    const after = await call('GET', `/api/v1/admin/jobs/${job.uuid}`);
    const j = (after.body as { data: { state: string; progress: number } }).data;
    expect(j).toMatchObject({ state: 'succeeded', progress: 100 });
    const audit = await call('GET', '/api/v1/admin/audit-logs?limit=1');
    expect((audit.body as { data: { job_uuid: string }[] }).data[0]?.job_uuid).toBe(job.uuid);
  });

  it('dashboard theo phạm vi: số liệu bằng số dòng danh sách', async () => {
    for (const user of [SA, MINH]) {
      const d = (await call('GET', '/api/v1/admin/dashboard/summary', undefined, user)).body as {
        data: { counts: Record<string, number>; servers: unknown[] };
      };
      const count = async (path: string) =>
        ((await call('GET', `${path}?limit=200`, undefined, user)).body as { data: unknown[] }).data
          .length;
      expect(d.data.counts.servers).toBe(await count('/api/v1/admin/servers'));
      expect(d.data.counts.websites).toBe(await count('/api/v1/admin/websites'));
      expect(d.data.counts.databases).toBe(await count('/api/v1/admin/databases'));
      expect(d.data.servers).toHaveLength(d.data.counts.servers ?? -1);
    }
  });
});
