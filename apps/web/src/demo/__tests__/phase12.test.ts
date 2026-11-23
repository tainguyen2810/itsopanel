// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../dataset';
import { resetDb, setStepMs } from '../db';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

// Mockup 12.0: import từ panel khác (D-108), CIS chỉ đọc (D-109), cập nhật + journal (D-114), sẵn sàng production (D-115).
const BASE = 'http://demo.local';
const STEP = 5;
const SA = dataset.users.find((u) => u.role === 'SUPER_ADMIN')?.uuid ?? '';
const ADMIN = dataset.users.find((u) => u.role === 'ADMIN')?.uuid ?? '';
const SRV1 = dataset.servers[0]?.uuid ?? '';
const SRV2 = dataset.servers[1]?.uuid ?? '';
const SRV_OFF = dataset.servers[2]?.uuid ?? '';

type Imp = { uuid: string; state: string; source: string; summary: { selected: number } };
type Item = {
  uuid: string;
  import_uuid: string;
  selected: boolean;
  state: string;
  warnings: { code: string }[];
  target: { username: string };
  result: { files: number } | null;
};
const imports = dataset.imports as Imp[];
const items = dataset.import_items as Item[];
const PLANNED = imports.find((i) => i.state === 'planned')?.uuid ?? '';
const PARTIAL = imports.find((i) => i.state === 'partially_failed')?.uuid ?? '';

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
const A = (p: string) => `/api/v1/admin${p}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const valid = (path: string, method: string, r: { status: number; body: unknown }) =>
  expect(validateResponse(path, method, r.status, r.body)).toEqual([]);

/** Đợi job (202) chạy xong. */
async function finish(r: { status: number; body: unknown }) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const job = (r.body as { job: { uuid: string; steps: unknown[] } }).job;
  await wait(STEP * (job.steps.length + 3));
  const j = data<{ state: string }>(await call('GET', A(`/jobs/${job.uuid}`)));
  expect(j.state).toBe('succeeded');
}

beforeAll(() => {
  setStepMs(STEP);
  demoServer.listen({ onUnhandledFrame: 'error' });
});
beforeEach(() => resetDb());
afterAll(() => {
  demoServer.close();
  setStepMs(900);
});

describe('Import từ panel khác (D-108)', () => {
  it('chỉ SUPER_ADMIN; ADMIN nhận 403', async () => {
    expect((await call('GET', A('/imports'), undefined, ADMIN)).status).toBe(403);
    expect(
      (await call('POST', A('/imports'), { source: 'aapanel', server: SRV1 }, ADMIN)).status,
    ).toBe(403);
  });

  it('quét aaPanel → kế hoạch có mục và cảnh báo, theo schema', async () => {
    const r = await call('POST', A('/imports'), { source: 'aapanel', server: SRV2 });
    valid('/api/v1/admin/imports', 'post', r);
    const uuid = (r.body as { resource: { uuid: string } }).resource.uuid;
    await finish(r);
    const imp = await call('GET', A(`/imports/${uuid}`));
    valid('/api/v1/admin/imports/{id}', 'get', imp);
    expect(data<Imp>(imp).state).toBe('planned');
    const list = data<Item[]>(await call('GET', A(`/imports/${uuid}/items`)));
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((i) => i.warnings.some((w) => w.code === 'domain_exists'))).toBe(true);
  });

  it('nguồn không có cài đặt → scan_failed kèm lý do; máy mất kết nối → 409', async () => {
    const r = await call('POST', A('/imports'), { source: 'nginx', server: SRV2 });
    const uuid = (r.body as { resource: { uuid: string } }).resource.uuid;
    await finish(r);
    const imp = data<Imp & { error: string }>(await call('GET', A(`/imports/${uuid}`)));
    expect(imp.state).toBe('scan_failed');
    expect(imp.error).toMatch(/sites-enabled/);
    expect((await call('POST', A('/imports'), { source: 'aapanel', server: SRV_OFF })).status).toBe(
      409,
    );
  });

  it('kế hoạch: chọn mục trùng domain hoặc username có sẵn → 422 theo từng mục', async () => {
    const own = items.filter((i) => i.import_uuid === PLANNED);
    const dup = own.find((i) => i.warnings.some((w) => w.code === 'domain_exists'));
    const ok = own.find((i) => i.selected);
    const r = await call('PUT', A(`/imports/${PLANNED}/plan`), {
      items: [
        { uuid: dup?.uuid, selected: true },
        { uuid: ok?.uuid, selected: true, username: 'anphat' },
      ],
    });
    expect(r.status).toBe(422);
    const errors = (r.body as { errors: Record<string, string[]> }).errors;
    expect(Object.keys(errors)).toEqual(
      expect.arrayContaining(['items.0.selected', 'items.1.username']),
    );
  });

  it('bỏ chọn rồi chạy → completed, có báo cáo; cutover → rollback', async () => {
    const own = items.filter((i) => i.import_uuid === PLANNED && i.selected);
    const drop = own[0];
    const r = await call('PUT', A(`/imports/${PLANNED}/plan`), {
      items: [{ uuid: drop?.uuid, selected: false }],
    });
    valid('/api/v1/admin/imports/{id}/plan', 'put', r);
    expect(data<Imp>(r).summary.selected).toBe(own.length - 1);
    expect((await call('POST', A(`/imports/${PLANNED}:cutover`))).status).toBe(409);
    await finish(await call('POST', A(`/imports/${PLANNED}:run`)));
    expect(data<Imp>(await call('GET', A(`/imports/${PLANNED}`))).state).toBe('completed');
    const after = data<Item[]>(await call('GET', A(`/imports/${PLANNED}/items`)));
    expect(after.find((i) => i.uuid === drop?.uuid)?.state).toBe('skipped');
    expect(after.filter((i) => i.state === 'done').every((i) => (i.result?.files ?? 0) > 0)).toBe(
      true,
    );
    expect((await call('PUT', A(`/imports/${PLANNED}/plan`), { items: [] })).status).toBe(409);
    await finish(await call('POST', A(`/imports/${PLANNED}:cutover`)));
    expect(data<Imp>(await call('GET', A(`/imports/${PLANNED}`))).state).toBe('cut_over');
    await finish(await call('POST', A(`/imports/${PLANNED}:rollback`)));
    expect(data<Imp>(await call('GET', A(`/imports/${PLANNED}`))).state).toBe('rolled_back');
  });

  it('lỗi một phần vẫn cutover được; xóa lượt import không đụng account', async () => {
    await finish(await call('POST', A(`/imports/${PARTIAL}:cutover`)));
    const accounts = (dataset.accounts as unknown[]).length;
    expect((await call('DELETE', A(`/imports/${PARTIAL}`))).status).toBe(204);
    expect((await call('GET', A(`/imports/${PARTIAL}`))).status).toBe(404);
    expect(
      data<unknown[]>(await call('GET', A('/hosting-accounts'))).length,
    ).toBeGreaterThanOrEqual(Math.min(accounts, 50));
  });
});

describe('CIS chỉ đọc (D-109)', () => {
  it('server chưa quét trả báo cáo rỗng; chạy kiểm → có mục, điểm theo pass/fail', async () => {
    const before = await call('GET', A(`/security/cis?server=${SRV2}`));
    valid('/api/v1/admin/security/cis', 'get', before);
    expect(data<{ audited_at: string | null; items: unknown[] }>(before).audited_at).toBeNull();
    await finish(await call('POST', A(`/security/cis:audit?server=${SRV2}`)));
    const r = data<{ score: number; passed: number; failed: number; items: { status: string }[] }>(
      await call('GET', A(`/security/cis?server=${SRV2}`)),
    );
    expect(r.items.length).toBeGreaterThan(30);
    expect(r.score).toBe(Math.round((100 * r.passed) / (r.passed + r.failed)));
  });
  it('thiếu server → 422', async () => {
    expect((await call('GET', A('/security/cis'))).status).toBe(422);
  });
});

describe('Cập nhật và sẵn sàng production', () => {
  it('updates có journal dở dang + lệnh repair, lịch sử theo schema', async () => {
    const r = await call('GET', A('/system/updates'));
    valid('/api/v1/admin/system/updates', 'get', r);
    const u = data<{
      journal: { step: string } | null;
      repair_command: string;
      history: unknown[];
    }>(r);
    expect(u.journal?.step).toBe('migrated');
    expect(u.repair_command).toMatch(/itso repair/);
    expect(u.history.length).toBeGreaterThan(2);
  });
  it('readiness chỉ SUPER_ADMIN; chưa sẵn sàng khi Gate còn chờ VM', async () => {
    expect((await call('GET', A('/system/readiness'), undefined, ADMIN)).status).toBe(403);
    const r = await call('GET', A('/system/readiness'));
    valid('/api/v1/admin/system/readiness', 'get', r);
    const d = data<{ ready: boolean; gate: { status: string }[] }>(r);
    expect(d.ready).toBe(false);
    expect(d.gate).toHaveLength(8);
    expect(d.gate.every((g) => g.status === 'pending_vm')).toBe(true);
  });
});
