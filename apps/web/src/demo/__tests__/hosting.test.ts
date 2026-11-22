// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../dataset';
import { db, resetDb, setStepMs } from '../db';
import { limitsError } from '../handlers/hosting';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

const BASE = 'http://demo.local';
const SA = '01938a01-0001-7000-8000-000001000001';
const HAI = '01938a01-000e-7000-8000-00000100000e';
const MINH = '01938a01-0002-7000-8000-000001000002';
const OWNER = '01938a01-0004-7000-8000-000001000004';
const HN1 = '01938a02-0001-7000-8000-000002000001';
const HN2 = '01938a02-0002-7000-8000-000002000002';
const HCM = '01938a02-0003-7000-8000-000002000003';
const BASIC = '01938a03-0001-7000-8000-000003000001';
const BUSINESS = '01938a03-0002-7000-8000-000003000002';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const LEHOA = '01938a05-0003-7000-8000-000005000003';
const OLDSHOP = '01938a05-0004-7000-8000-000005000004';
const SAOMAI = '01938a05-0006-7000-8000-000005000006';
const PURGE = '01938a16-0001-7000-8000-000016000001';
const MIG = '01938a15-0001-7000-8000-000015000001';
const LIMITS = dataset.packages[0]?.limits;
const STEP = 10;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

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
const data = <T>(r: { body: unknown }) => (r.body as { data: T }).data;
async function finish(r: { status: number; body: unknown }) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const job = (r.body as { job: { uuid: string; steps: unknown[] } }).job;
  await wait(STEP * (job.steps.length + 3));
  const j = data<{ state: string }>(await call('GET', `/api/v1/admin/jobs/${job.uuid}`));
  expect(j.state).toBe('succeeded');
}
const account = async (id: string, user = SA) =>
  data<{
    lifecycle_state: string;
    server: { uuid: string };
    package: { version: number };
    purge_after: string | null;
  }>(await call('GET', `/api/v1/admin/hosting-accounts/${id}`, undefined, user));

beforeAll(() => {
  setStepMs(STEP);
  demoServer.listen({ onUnhandledFrame: 'error' });
});
beforeEach(() => resetDb());
afterAll(() => {
  demoServer.close();
  setStepMs(900);
});

const newAccount = {
  owner_user_uuid: OWNER,
  package_uuid: BASIC,
  server_uuid: HN2,
  username: 'phongkt',
  primary_domain: 'ketoan.itso.vn',
};
const pkg = { code: 'student', name: 'Sinh viên', description: null, limits: LIMITS };

/** [method, template OpenAPI, url, body, status mong đợi, người gọi] */
const CASES: [string, string, string, unknown, number, string?][] = [
  ['post', '/api/v1/admin/hosting-packages', '/api/v1/admin/hosting-packages', pkg, 201],
  [
    'post',
    '/api/v1/admin/hosting-packages',
    '/api/v1/admin/hosting-packages',
    { ...pkg, code: 'basic' },
    409,
  ],
  [
    'post',
    '/api/v1/admin/hosting-packages',
    '/api/v1/admin/hosting-packages',
    { ...pkg, limits: { ...LIMITS, retention_days_after_terminate: 7 } },
    422,
  ],
  ['post', '/api/v1/admin/hosting-packages', '/api/v1/admin/hosting-packages', pkg, 403, MINH],
  [
    'delete',
    '/api/v1/admin/hosting-packages/{id}',
    `/api/v1/admin/hosting-packages/${BASIC}`,
    undefined,
    409,
  ],
  [
    'post',
    '/api/v1/admin/hosting-packages/{id}/versions/{version}:migrate-accounts',
    `/api/v1/admin/hosting-packages/${BUSINESS}/versions/1:migrate-accounts`,
    {},
    409,
  ],
  ['post', '/api/v1/admin/hosting-accounts', '/api/v1/admin/hosting-accounts', newAccount, 202],
  [
    'post',
    '/api/v1/admin/hosting-accounts',
    '/api/v1/admin/hosting-accounts',
    { ...newAccount, username: 'anphat' },
    409,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts',
    '/api/v1/admin/hosting-accounts',
    { ...newAccount, username: 'root' },
    422,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts',
    '/api/v1/admin/hosting-accounts',
    { ...newAccount, server_uuid: HCM },
    409,
  ],
  // ADMIN Trần Minh chỉ có phạm vi srv-hn-01: không tạo được account trên srv-hn-02.
  [
    'post',
    '/api/v1/admin/hosting-accounts',
    '/api/v1/admin/hosting-accounts',
    newAccount,
    422,
    MINH,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts',
    '/api/v1/admin/hosting-accounts',
    { ...newAccount, server_uuid: HN1 },
    202,
    MINH,
  ],
  [
    'patch',
    '/api/v1/admin/hosting-accounts/{id}',
    `/api/v1/admin/hosting-accounts/${ANPHAT}`,
    { legal_hold: true },
    200,
  ],
  [
    'patch',
    '/api/v1/admin/hosting-accounts/{id}',
    `/api/v1/admin/hosting-accounts/${ANPHAT}`,
    { legal_hold: true },
    403,
    MINH,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:suspend',
    `/api/v1/admin/hosting-accounts/${ANPHAT}:suspend`,
    { reason: 'Vi phạm điều khoản' },
    202,
    MINH,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:suspend',
    `/api/v1/admin/hosting-accounts/${ANPHAT}:suspend`,
    { reason: 'x' },
    422,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:unsuspend',
    `/api/v1/admin/hosting-accounts/${ANPHAT}:unsuspend`,
    {},
    409,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:change-package',
    `/api/v1/admin/hosting-accounts/${ANPHAT}:change-package`,
    { package_uuid: BASIC },
    202,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:terminate',
    `/api/v1/admin/hosting-accounts/${ANPHAT}:terminate`,
    { reason: 'Ngừng dịch vụ', confirm_username: 'sai' },
    422,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:schedule-purge',
    `/api/v1/admin/hosting-accounts/${ANPHAT}:schedule-purge`,
    {},
    409,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:schedule-purge',
    `/api/v1/admin/hosting-accounts/${OLDSHOP}:schedule-purge`,
    {},
    202,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:confirm-purge',
    `/api/v1/admin/hosting-accounts/${OLDSHOP}:confirm-purge`,
    { purge_uuid: PURGE, confirm_username: 'oldshop' },
    409,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:confirm-purge',
    `/api/v1/admin/hosting-accounts/${OLDSHOP}:confirm-purge`,
    { purge_uuid: PURGE, confirm_username: 'oldshop' },
    202,
    HAI,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:migrate-preflight',
    `/api/v1/admin/hosting-accounts/${SAOMAI}:migrate-preflight`,
    { target_server_uuid: HN1 },
    200,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:migrate',
    `/api/v1/admin/hosting-accounts/${SAOMAI}:migrate`,
    { target_server_uuid: HN2 },
    422,
  ],
  [
    'post',
    '/api/v1/admin/hosting-accounts/{id}:migrate',
    `/api/v1/admin/hosting-accounts/${ANPHAT}:migrate`,
    { target_server_uuid: HN2 },
    422, // ADMIN được chuyển nhưng server đích ngoài phạm vi (như API thật)
    MINH,
  ],
  [
    'post',
    '/api/v1/admin/account-migrations/{id}:rollback',
    `/api/v1/admin/account-migrations/${MIG}:rollback`,
    {},
    202,
  ],
  [
    'get',
    '/api/v1/admin/hosting-accounts/{id}/lifecycle-events',
    `/api/v1/admin/hosting-accounts/${ANPHAT}/lifecycle-events`,
    undefined,
    200,
  ],
];

describe('API giả lập gói và tài khoản hosting', () => {
  it.each(CASES)('%s %s → %s', async (method, template, url, body, status, user) => {
    const r = await call(method.toUpperCase(), url, body, user);
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    expect(validateResponse(template, method, r.status, r.body)).toEqual([]);
  });

  it('limitsError: bắt giữ dữ liệu < 30 ngày và thiếu phiên bản PHP', () => {
    expect(limitsError(LIMITS)).toBeNull();
    expect(limitsError({ ...LIMITS, retention_days_after_terminate: 29 })).toMatch(/30/);
    expect(limitsError({ ...LIMITS, php_versions: [] })).toMatch(/PHP/);
    expect(limitsError({ ...LIMITS, disk_mb: 0 })).toMatch(/disk_mb/);
  });

  it('tạo account → job xong → active, có website, xuất hiện trong danh sách', async () => {
    const r = await call('POST', '/api/v1/admin/hosting-accounts', newAccount);
    const uuid = (r.body as { resource: { uuid: string } }).resource.uuid;
    expect((await account(uuid)).lifecycle_state).toBe('provisioning');
    await finish(r);
    expect((await account(uuid)).lifecycle_state).toBe('active');
    const list = await call('GET', '/api/v1/admin/hosting-accounts?per_page=100');
    expect(data<{ username: string }[]>(list).map((a) => a.username)).toContain('phongkt');
    const sites = data<{ primary_domain: string }[]>(
      await call('GET', '/api/v1/admin/websites?per_page=100'),
    );
    expect(sites.map((s) => s.primary_domain)).toContain('ketoan.itso.vn');
    const events = data<{ to_state: string }[]>(
      await call('GET', `/api/v1/admin/hosting-accounts/${uuid}/lifecycle-events`),
    );
    expect(events.map((e) => e.to_state)).toEqual(['active', 'provisioning']);
  });

  it('D-43: đổi giới hạn gói tạo phiên bản mới, account cũ giữ phiên bản cũ tới khi chuyển', async () => {
    const r = await call('PATCH', `/api/v1/admin/hosting-packages/${BUSINESS}`, {
      limits: { ...LIMITS, disk_mb: 99999 },
    });
    expect(data<{ current_version: number }>(r).current_version).toBe(2);
    expect((await account(ANPHAT)).package.version).toBe(1);
    await finish(
      await call(
        'POST',
        `/api/v1/admin/hosting-packages/${BUSINESS}/versions/2:migrate-accounts`,
        {},
      ),
    );
    expect((await account(ANPHAT)).package.version).toBe(2);
    // Đổi tên không tạo phiên bản.
    const r2 = await call('PATCH', `/api/v1/admin/hosting-packages/${BUSINESS}`, {
      name: 'Doanh nghiệp+',
    });
    expect(data<{ current_version: number }>(r2).current_version).toBe(2);
  });

  it('D-46: chấm dứt → lên lịch purge (SA A) → SA A không tự xác nhận → SA B xác nhận', async () => {
    await finish(
      await call(
        'POST',
        `/api/v1/admin/hosting-accounts/${ANPHAT}:terminate`,
        { reason: 'Ngừng dịch vụ', confirm_username: 'anphat' },
        MINH,
      ),
    );
    const a = await account(ANPHAT);
    expect(a.lifecycle_state).toBe('terminated');
    const days = (Date.parse(a.purge_after ?? '') - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(29.9);
    // ADMIN không được lên lịch purge.
    expect(
      (await call('POST', `/api/v1/admin/hosting-accounts/${ANPHAT}:schedule-purge`, {}, MINH))
        .status,
    ).toBe(403);
    const r = await call('POST', `/api/v1/admin/hosting-accounts/${ANPHAT}:schedule-purge`, {
      final_backup: true,
    });
    const purge = (r.body as { job: { changes?: { purge_uuid?: string } } }).job;
    await finish(r);
    const recs = data<{ uuid: string; hosting_account: { uuid: string } }[]>(
      await call('GET', '/api/v1/admin/purge-records?per_page=100'),
    );
    const rec = recs.find((p) => p.hosting_account.uuid === ANPHAT);
    expect(rec, JSON.stringify(purge)).toBeDefined();
    const body = { purge_uuid: rec?.uuid, confirm_username: 'anphat' };
    // Mới chấm dứt: còn trong hạn giữ dữ liệu → chưa xác nhận được (như PurgeService).
    const early = await call(
      'POST',
      `/api/v1/admin/hosting-accounts/${ANPHAT}:confirm-purge`,
      body,
      HAI,
    );
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toContain('Chưa tới hạn');

    // oldshop đã hết hạn giữ: SA A lên lịch lại (thay biên bản cũ) → tự xác nhận 409 → SA B xác nhận → purge ngay.
    await finish(
      await call('POST', `/api/v1/admin/hosting-accounts/${OLDSHOP}:schedule-purge`, {}),
    );
    const open = data<
      { uuid: string; hosting_account: { uuid: string }; completed_at: string | null }[]
    >(await call('GET', '/api/v1/admin/purge-records?per_page=100')).filter(
      (p) => p.hosting_account.uuid === OLDSHOP && !p.completed_at,
    );
    expect(open).toHaveLength(1);
    const ob = { purge_uuid: open[0]?.uuid, confirm_username: 'oldshop' };
    const self = await call('POST', `/api/v1/admin/hosting-accounts/${OLDSHOP}:confirm-purge`, ob);
    expect(self.status).toBe(409);
    expect(JSON.stringify(self.body)).toContain('người xác nhận thứ hai');
    const ok = await call(
      'POST',
      `/api/v1/admin/hosting-accounts/${OLDSHOP}:confirm-purge`,
      ob,
      HAI,
    );
    expect((ok.body as { job: { type: string } }).job.type).toBe('hosting_account.purge');
    await finish(ok);
    expect((await account(OLDSHOP)).lifecycle_state).toBe('purged');
    expect(
      (await call('POST', `/api/v1/admin/hosting-accounts/${OLDSHOP}:confirm-purge`, ob, HAI))
        .status,
    ).toBe(422);
  });

  it('legal hold chặn lên lịch purge', async () => {
    await call('PATCH', `/api/v1/admin/hosting-accounts/${ANPHAT}`, { legal_hold: true });
    await finish(
      await call('POST', `/api/v1/admin/hosting-accounts/${ANPHAT}:terminate`, {
        reason: 'Ngừng dịch vụ',
        confirm_username: 'anphat',
      }),
    );
    const r = await call('POST', `/api/v1/admin/hosting-accounts/${ANPHAT}:schedule-purge`, {});
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/legal hold/);
  });

  it('kiểm tra trước: đích mất kết nối → chặn, không tạo lần chuyển', async () => {
    const pre = data<{ ok: boolean; checks: { key: string; level: string }[] }>(
      await call('POST', `/api/v1/admin/hosting-accounts/${SAOMAI}:migrate-preflight`, {
        target_server_uuid: HCM,
      }),
    );
    expect(pre.ok).toBe(false);
    expect(pre.checks.find((c) => c.key === 'connection')?.level).toBe('block');
    const r = await call('POST', `/api/v1/admin/hosting-accounts/${SAOMAI}:migrate`, {
      target_server_uuid: HCM,
    });
    expect(r.status).toBe(409);
    expect((await account(SAOMAI)).lifecycle_state).toBe('active');
  });

  it('chuyển server: sync + kiểm tra → verifying → cutover → holding → dọn nguồn → completed', async () => {
    const r = await call('POST', `/api/v1/admin/hosting-accounts/${SAOMAI}:migrate`, {
      target_server_uuid: HN1,
      keep_source_days: 7,
    });
    expect((await account(SAOMAI)).lifecycle_state).toBe('migrating');
    await finish(r);
    const migs = data<{ uuid: string; state: string; hosting_account: { uuid: string } }[]>(
      await call('GET', '/api/v1/admin/account-migrations?per_page=100'),
    );
    const m = migs.find((x) => x.hosting_account.uuid === SAOMAI);
    expect(m?.state).toBe('verifying');
    // Đang có lần chuyển chưa xong → không tạo lần mới.
    expect(
      (
        await call('POST', `/api/v1/admin/hosting-accounts/${SAOMAI}:migrate`, {
          target_server_uuid: HN1,
        })
      ).status,
    ).toBe(409);
    await finish(await call('POST', `/api/v1/admin/account-migrations/${m?.uuid}:cutover`, {}));
    const a = await account(SAOMAI);
    expect(a.server.uuid).toBe(HN1);
    expect(a.lifecycle_state).toBe('active');
    const held = data<{ state: string; cleanup_after: string; verification: unknown[] }>(
      await call('GET', `/api/v1/admin/account-migrations/${m?.uuid}`),
    );
    expect(held.state).toBe('holding');
    expect(held.cleanup_after).toBeTruthy();
    expect(held.verification.length).toBeGreaterThan(1);
    const url = `/api/v1/admin/account-migrations/${m?.uuid}:cleanup`;
    expect((await call('POST', url, { confirm_username: 'sai' })).status).toBe(422);
    await finish(await call('POST', url, { confirm_username: 'saomai' }));
    expect(
      data<{ state: string }>(await call('GET', `/api/v1/admin/account-migrations/${m?.uuid}`))
        .state,
    ).toBe('completed');
  });

  it('hoàn tác khi đang giữ nguồn đưa account về máy cũ', async () => {
    await finish(await call('POST', `/api/v1/admin/account-migrations/${MIG}:cutover`, {}));
    expect((await account(LEHOA)).server.uuid).toBe(HN2);
    await finish(await call('POST', `/api/v1/admin/account-migrations/${MIG}:rollback`, {}));
    expect((await account(LEHOA)).server.uuid).toBe(HCM);
  });

  it('như API thật: kiểm chứng lệch → cutover 409; đang đồng bộ → hoàn tác 409; HTTP chỉ có sau cutover', async () => {
    const m = db().data.migrations.find((x) => x.uuid === MIG);
    expect(m).toBeDefined();
    const saved = m!.verification;
    m!.verification = [
      ...saved,
      { kind: 'database', name: 'lehoa_wp', ok: false, detail: 'sha256 dump lệch' },
    ];
    const c = await call('POST', `/api/v1/admin/account-migrations/${MIG}:cutover`, {});
    expect(c.status).toBe(409);
    expect((c.body as { code: string }).code).toBe('precondition_failed');
    m!.verification = saved;
    const r = await call('POST', `/api/v1/admin/hosting-accounts/${SAOMAI}:migrate`, {
      target_server_uuid: HN1,
    });
    const mig = db().data.migrations.find((x) => x.hosting_account.uuid === SAOMAI);
    expect(mig?.state).toBe('syncing');
    expect(
      (await call('POST', `/api/v1/admin/account-migrations/${mig?.uuid}:rollback`, {})).status,
    ).toBe(409);
    // Account đang chuyển → ghi dữ liệu bị chặn như DataJobs của API thật.
    const cron = await call('POST', '/api/v1/admin/cron-jobs', {
      hosting_account_uuid: SAOMAI,
      schedule: '0 3 * * *',
      command: 'true',
    });
    expect(cron.status).toBe(409);
    await finish(r);
    expect(mig?.verification.some((v) => v.kind === 'http')).toBe(false);
    await finish(await call('POST', `/api/v1/admin/account-migrations/${mig?.uuid}:cutover`, {}));
    expect(mig?.verification.some((v) => v.kind === 'http')).toBe(true);
  });

  it('cutover lần chuyển mẫu của lehoa đưa account sang srv-hn-02', async () => {
    await finish(await call('POST', `/api/v1/admin/account-migrations/${MIG}:cutover`, {}));
    expect((await account(LEHOA)).server.uuid).toBe(HN2);
  });
});

describe('Phase 6: dữ liệu hosting trên API giả lập', () => {
  it('tải lên: lệch offset → 409 kèm errors.received; GET/DELETE phiên', async () => {
    const base = `/api/v1/admin/hosting-accounts/${ANPHAT}/files/uploads`;
    const up = data<{ uuid: string }>(await call('POST', base, { path: 'p6.bin', size: 10 }));
    const chunk = (range: string) =>
      fetch(`${BASE}${base}/${up.uuid}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/offset+octet-stream',
          'Content-Range': range,
          'X-Demo-User': SA,
        },
        body: new Uint8Array(5),
      });
    expect((await chunk('bytes 0-4/10')).status).toBe(200);
    const bad = await chunk('bytes 0-4/10');
    expect(bad.status).toBe(409);
    expect(((await bad.json()) as { errors: { received: string[] } }).errors.received).toEqual([
      '5',
    ]);
    expect(data<{ received: number }>(await call('GET', `${base}/${up.uuid}`)).received).toBe(5);
    expect((await call('DELETE', `${base}/${up.uuid}`)).status).toBe(204);
    expect(data<{ status: string }>(await call('GET', `${base}/${up.uuid}`)).status).toBe(
      'cancelled',
    );
  });

  it('mật khẩu do panel sinh trả MỘT lần trong JobAccepted.secret', async () => {
    const created = await call('POST', '/api/v1/admin/sftp-accounts', {
      hosting_account_uuid: ANPHAT,
      username: 'anphat_p6',
      protocol: 'sftp',
      root_path: '.',
      password: null,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    expect((created.body as { secret: string }).secret).toMatch(/.{16,}/);
    const id = (created.body as { resource: { uuid: string } }).resource.uuid;
    const rot = await call('POST', `/api/v1/admin/sftp-accounts/${id}:rotate-password`, {});
    expect(rot.status).toBe(202);
    expect((rot.body as { secret: string }).secret).toMatch(/.{16,}/);
  });
});
