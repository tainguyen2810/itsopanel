// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { kitText } from '@/entries/admin/backups/RecoveryKitDialog';
import { quotaState } from '@/shared/hosting/pages/backup';
import { resetDb, setStepMs } from '../db';
import { resetDemoSetup, DEMO_SETUP_CODE } from '../handlers/setup';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

// Prompt 8.0: hành vi demo cho mockup Backup & Restore (D-82…D-87).
const BASE = 'http://demo.local';
const SA = '01938a01-0001-7000-8000-000001000001';
const MINH = '01938a01-0002-7000-8000-000001000002';
const ANPHAT_USER = '01938a01-0003-7000-8000-000001000003';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const GIONUI = '01938a05-0009-7000-8000-000005000009';
const D_LOCAL = '01938a17-0001-7000-8000-000017000001';
const D_S3 = '01938a17-0002-7000-8000-000017000002';
const SNAP = '01938a0e-0001-7000-8000-00000e000001';
const STEP = 10;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function call(
  method: string,
  url: string,
  body?: unknown,
  user = SA,
  realm: 'admin' | 'portal' = 'admin',
) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-User': user,
      'X-Demo-Realm': realm,
      'Idempotency-Key': crypto.randomUUID(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = res.status === 204 ? undefined : await res.json();
  return { status: res.status, body: json };
}
const data = <T>(r: { body: unknown }) => (r.body as { data: T }).data;
const code = (r: { body: unknown }) => (r.body as { code?: string }).code;
const valid = (path: string, method: string, r: { status: number; body: unknown }) =>
  expect(validateResponse(path, method, r.status, r.body)).toEqual([]);
async function finish(r: { status: number; body: unknown }, user = SA) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const job = (r.body as { job: { uuid: string; steps: unknown[] } }).job;
  await wait(STEP * (job.steps.length + 3));
  const j = data<{ state: string }>(
    await call('GET', `/api/v1/admin/jobs/${job.uuid}`, undefined, user),
  );
  expect(j.state).toBe('succeeded');
}

beforeAll(() => {
  setStepMs(STEP);
  demoServer.listen({ onUnhandledFrame: 'error' });
});
beforeEach(() => {
  resetDb();
  resetDemoSetup();
});
afterAll(() => {
  demoServer.close();
  setStepMs(900);
});

describe('Tổng quan 3-2-1-1-0', () => {
  it('tính từ dữ kiện: SFTP lỗi + chính sách lỗi → điều kiện "0 lỗi" chưa đạt, có lý do', async () => {
    const r = await call('GET', '/api/v1/admin/backups/overview');
    valid('/api/v1/admin/backups/overview', 'get', r);
    const o = data<{
      rules: { key: string; ok: boolean; reason: string | null }[];
      quota: { hosting_account: { username: string }; state: string }[];
      destinations: { immutable: boolean }[];
    }>(r);
    const by = Object.fromEntries(o.rules.map((x) => [x.key, x]));
    expect(by.copies?.ok && by.media?.ok && by.offsite?.ok && by.immutable?.ok).toBe(true);
    expect(by.errors?.ok).toBe(false);
    expect(by.errors?.reason).toContain('SFTP văn phòng HCM');
    expect(o.quota.map((q) => [q.hosting_account.username, q.state])).toEqual([
      ['mktitso', 'warn'],
      ['gionui', 'paused'],
    ]);
    expect(o.destinations.filter((d) => d.immutable)).toHaveLength(1);
  });
  it('job backup đang chạy hiện trong tổng quan', async () => {
    setStepMs(5000);
    const r = await call('POST', '/api/v1/admin/backups', {
      hosting_account_uuid: ANPHAT,
      contents: ['files'],
    });
    expect(r.status).toBe(202);
    const o = data<{ running: { type: string }[] }>(
      await call('GET', '/api/v1/admin/backups/overview'),
    );
    expect(o.running.map((j) => j.type)).toContain('backup.manual');
    setStepMs(STEP);
  });
});

describe('Đích và bộ khôi phục', () => {
  it('tạo đích SFTP: agent sinh khóa công khai, bộ khôi phục hiện lần đầu, xác nhận đã lưu', async () => {
    const c = await call('POST', '/api/v1/admin/backup-destinations', {
      name: 'SFTP thử',
      type: 'sftp',
      append_only: false,
      immutable_days: null,
      config: { host: 'backup.test', port: '22', user: 'itso', path: '/srv/b' },
    });
    expect(c.status).toBe(201);
    const d = data<{ uuid: string; ssh_public_key: string; recovery_kit_acknowledged_at: null }>(c);
    expect(d.ssh_public_key).toMatch(/^ssh-ed25519 /);
    const k1 = await call('POST', `/api/v1/admin/backup-destinations/${d.uuid}:recovery-kit`);
    valid('/api/v1/admin/backup-destinations/{id}:recovery-kit', 'post', k1);
    const kit = data<Parameters<typeof kitText>[0]>(k1);
    expect(kit.first_view).toBe(true);
    expect(kit.panel_private_key).toMatch(/^AGE-SECRET-KEY-1/);
    expect(kitText(kit)).toContain(kit.repositories[0]?.password ?? 'x');
    // CLI `itso backup panel-restore` (ParseKit) cần dòng destination_uuid.
    expect(kitText(kit)).toContain(`\ndestination_uuid: ${d.uuid}\n`);
    const ack = await call('POST', `/api/v1/admin/backup-destinations/${d.uuid}:recovery-kit-ack`);
    expect(ack.status).toBe(204);
    const k2 = data<{ first_view: boolean }>(
      await call('POST', `/api/v1/admin/backup-destinations/${d.uuid}:recovery-kit`),
    );
    expect(k2.first_view).toBe(false);
  });
  it('ADMIN không xem được bộ khôi phục', async () => {
    const r = await call(
      'POST',
      `/api/v1/admin/backup-destinations/${D_S3}:recovery-kit`,
      undefined,
      MINH,
    );
    expect(r.status).toBe(403);
  });
  it('kiểm tra kết nối ghi lại dữ kiện phát hiện được (Object Lock)', async () => {
    await finish(await call('POST', `/api/v1/admin/backup-destinations/${D_S3}:test`));
    const d = data<{ detected: { object_lock_days: number } }>(
      await call('GET', `/api/v1/admin/backup-destinations/${D_S3}`),
    );
    expect(d.detected.object_lock_days).toBe(30);
  });
  it('repo theo đích × account', async () => {
    const r = await call('GET', `/api/v1/admin/backup-repositories?filter[destination]=${D_LOCAL}`);
    valid('/api/v1/admin/backup-repositories', 'get', r);
    const rows = data<{ destination: { uuid: string }; scope_type: string }[]>(r);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.every((x) => x.destination.uuid === D_LOCAL)).toBe(true);
    expect(rows.some((x) => x.scope_type === 'server')).toBe(true);
  });
});

describe('Chính sách', () => {
  it('đích bất biến → retention_mode=cli, chạy không có forget; loại trừ sai bị từ chối', async () => {
    const base = {
      name: 'Website anphat',
      scope_type: 'website',
      scope_uuid: '01938a06-0001-7000-8000-000006000001',
      contents: ['files'],
      excludes: ['**/cache/**'],
      schedule: '0 3 * * *',
      destination_uuids: [D_S3],
      retention: { daily: 7 },
      enabled: true,
    };
    const bad = await call('POST', '/api/v1/admin/backup-policies', {
      ...base,
      excludes: ['../etc'],
    });
    expect(bad.status).toBe(422);
    const r = await call('POST', '/api/v1/admin/backup-policies', base);
    expect(r.status).toBe(201);
    const p = data<{ uuid: string; retention_mode: string }>(r);
    expect(p.retention_mode).toBe('cli');
    const run = await call('POST', `/api/v1/admin/backup-policies/${p.uuid}:run`);
    const ops = (run.body as { job: { steps: { op: string }[] } }).job.steps.map((s) => s.op);
    expect(ops).not.toContain('backup.forget');
  });
});

describe('Snapshot, tải file lẻ, khôi phục', () => {
  it('lọc theo loại và đích', async () => {
    const r = await call('GET', '/api/v1/admin/backup-snapshots?filter[scope_type]=panel');
    const rows = data<{ scope_type: string }[]>(r);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.scope_type === 'panel')).toBe(true);
  });
  it('link tải một file trong snapshot; đường dẫn ngoài home bị từ chối', async () => {
    const ok = await call('POST', `/api/v1/admin/backup-snapshots/${SNAP}:download-link`, {
      path: 'sites/anphat.vn/public/index.php',
    });
    valid('/api/v1/admin/backup-snapshots/{id}:download-link', 'post', ok);
    expect(data<{ url: string }>(ok).url).toContain('index.php');
    const bad = await call('POST', `/api/v1/admin/backup-snapshots/${SNAP}:download-link`, {
      path: '../../etc/shadow',
    });
    expect(bad.status).toBe(422);
  });
  it('khôi phục DB ra bản mới → kết quả có tên DB mới; ghi đè có snapshot trước', async () => {
    await finish(
      await call('POST', '/api/v1/admin/restores', {
        snapshot_uuid: SNAP,
        mode: 'new',
        items: ['database:anphat_shop', 'files:sites/anphat.vn'],
      }),
    );
    const [r] = data<{ result: { databases: string[]; restored_paths: string[] } }[]>(
      await call('GET', '/api/v1/admin/restores'),
    );
    expect(r?.result.databases[0]).toMatch(/^anphat_shop_r\d{8}$/);
    expect(r?.result.restored_paths[0]).toMatch(
      /^backups\/restore-\d{8}-\d{4}\/sites\/anphat\.vn$/,
    );
    await finish(
      await call('POST', '/api/v1/admin/restores', {
        snapshot_uuid: SNAP,
        mode: 'overwrite',
        items: ['database:anphat_shop'],
        confirm: 'anphat',
      }),
    );
    const [o] = data<{ result: { pre_restore_snapshot_uuid: string | null } }[]>(
      await call('GET', '/api/v1/admin/restores'),
    );
    expect(o?.result.pre_restore_snapshot_uuid).toBeTruthy();
  });
  it('Portal: backup ngay bị chặn khi vượt 120 % quota', async () => {
    const gion = await call(
      'POST',
      '/api/v1/admin/backups',
      { hosting_account_uuid: GIONUI, contents: ['files'] },
      SA,
    );
    expect(gion.status).toBe(409);
    expect(code(gion)).toBe('quota_exceeded');
    const own = await call(
      'POST',
      '/api/v1/portal/backups',
      { hosting_account_uuid: ANPHAT, contents: ['databases'] },
      ANPHAT_USER,
      'portal',
    );
    expect(own.status).toBe(202);
  });
  it('kiểm chứng ghi vào lịch sử', async () => {
    await finish(await call('POST', `/api/v1/admin/backup-snapshots/${SNAP}:verify`));
    const r = await call('GET', '/api/v1/admin/backup-verifications');
    valid('/api/v1/admin/backup-verifications', 'get', r);
    const [v] = data<{ kind: string; snapshot_uuid: string }[]>(r);
    expect(v).toMatchObject({ kind: 'restore_test', snapshot_uuid: SNAP });
  });
  it('quotaState: 100 % cảnh báo, 120 % tạm dừng', () => {
    expect(quotaState(100, 100)).toBe('ok');
    expect(quotaState(101, 100)).toBe('warn');
    expect(quotaState(121, 100)).toBe('paused');
    expect(quotaState(5, 0)).toBe('ok');
  });
});

describe('Khôi phục thảm họa từ wizard', () => {
  const source = {
    type: 's3',
    config: { endpoint: 'https://s3.example.com', bucket: 'itso-backup' },
    credentials: { access_key: 'AK', secret_key: 'SK' },
    repository_path: 'itso/01938a02-0001-7000-8000-000002000001/server',
    repository_password: 'demo-Rk7-panel-9fQ2-xV4m-T8sL-3bNw',
    panel_private_key: `AGE-SECRET-KEY-1${'A'.repeat(58)}`,
  };
  it('cần mã thiết lập; mật khẩu sai → 422; đúng → danh sách bản panel → khôi phục xong thì wizard khóa', async () => {
    expect((await call('POST', '/api/v1/admin/setup/restore:inspect', source)).status).toBe(403);
    await call('POST', '/api/v1/admin/setup/code:verify', { code: DEMO_SETUP_CODE });
    const wrong = await call('POST', '/api/v1/admin/setup/restore:inspect', {
      ...source,
      repository_password: 'sai-mat-khau-0123456789',
    });
    expect(wrong.status).toBe(422);
    // Như API thật: SFTP đi đường CLI; thiếu đường dẫn repo server → 422.
    const sftp = await call('POST', '/api/v1/admin/setup/restore:inspect', {
      ...source,
      type: 'sftp',
      config: { host: 'bk.example.com', user: 'itso', path: '/srv/bk' },
    });
    expect(sftp.status).toBe(422);
    expect(JSON.stringify(sftp.body)).toContain('itso backup panel-restore');
    const noPath = { ...source, repository_path: 'itso/x/acct-1' };
    expect((await call('POST', '/api/v1/admin/setup/restore:inspect', noPath)).status).toBe(422);
    const ins = await call('POST', '/api/v1/admin/setup/restore:inspect', source);
    valid('/api/v1/admin/setup/restore:inspect', 'post', ins);
    const [c] = data<{ snapshot_id: string }[]>(ins);
    await finish(
      await call('POST', '/api/v1/admin/setup/restore', { source, snapshot_id: c?.snapshot_id }),
    );
    const st = data<{ installed: boolean }>(await call('GET', '/api/v1/admin/setup/status'));
    expect(st.installed).toBe(true);
  });
});
