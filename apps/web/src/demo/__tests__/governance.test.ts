// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv } from '@/shared/lib/csv';
import { resetDb, setStepMs } from '../db';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

const BASE = 'http://demo.local';
const SA = '01938a01-0001-7000-8000-000001000001';
const MINH = '01938a01-0002-7000-8000-000001000002';
const ANPHAT_USER = '01938a01-0003-7000-8000-000001000003';
const HOA = '01938a01-0005-7000-8000-000001000005';
const BINHMINH_USER = '01938a01-0007-7000-8000-000001000007';
const SAOMAI_USER = '01938a01-0008-7000-8000-000001000008';
const LAN = '01938a01-0006-7000-8000-000001000006';
const HAI = '01938a01-000e-7000-8000-00000100000e';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const SAOMAI = '01938a05-0006-7000-8000-000005000006';
const SRV_HN2 = '01938a02-0002-7000-8000-000002000002';
const SNAP_ANPHAT = '01938a0e-0001-7000-8000-00000e000001';
const SNAP_PURGE = '01938a0e-0002-7000-8000-00000e000002';
const DEST_LOCAL = '01938a17-0001-7000-8000-000017000001';
const DEST_S3 = '01938a17-0002-7000-8000-000017000002';
const POLICY = '01938a18-0001-7000-8000-000018000001';
const EVENT_OPEN = '01938a1a-0001-7000-8000-00001a000001';
const EVENT_HCM = '01938a1a-0007-7000-8000-00001a000007';
const QUAR = '01938a1c-0001-7000-8000-00001c000001';
const RULE_CPU = '01938a20-0001-7000-8000-000020000001';
const RULE_RAM = '01938a20-0003-7000-8000-000020000003';
const STEP = 10;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const A = (p: string) => `/api/v1/admin${p}`;

async function call(
  method: string,
  url: string,
  body?: unknown,
  user = SA,
  headers: Record<string, string> = {},
) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Demo-User': user,
      'Idempotency-Key': crypto.randomUUID(),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json: unknown = res.status === 204 ? undefined : await res.json();
  return { status: res.status, body: json };
}
const data = <T>(r: { body: unknown }) => (r.body as { data: T }).data;
const code = (r: { body: unknown }) => (r.body as { code?: string }).code;
async function finish(r: { status: number; body: unknown }) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const job = (r.body as { job: { uuid: string; steps: unknown[] } }).job;
  await wait(STEP * (job.steps.length + 3));
  const j = data<{ state: string }>(await call('GET', A(`/jobs/${job.uuid}`)));
  expect(j.state).toBe('succeeded');
  return job;
}
function valid(method: string, path: string, r: { status: number; body: unknown }) {
  expect(validateResponse(A(path), method, r.status, r.body)).toEqual([]);
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

describe('bảo mật', () => {
  it('xác nhận sự kiện một lần; ADMIN không thấy sự kiện server ngoài phạm vi', async () => {
    const r = await call('POST', A(`/security/events/${EVENT_OPEN}:acknowledge`));
    expect(r.status).toBe(200);
    valid('post', '/security/events/{id}:acknowledge', r);
    expect(data<{ acknowledged_at: string }>(r).acknowledged_at).toBeTruthy();
    expect(code(await call('POST', A(`/security/events/${EVENT_OPEN}:acknowledge`)))).toBe(
      'conflict',
    );
    const hcm = await call('POST', A(`/security/events/${EVENT_HCM}:acknowledge`), {}, LAN);
    expect(hcm.status).toBe(404);
  });

  it('SSH: chỉ SA, chặn cấu hình tự khóa, áp dụng qua job sshd.config.apply', async () => {
    expect((await call('PATCH', A('/security/ssh'), { port: 2222 }, MINH)).status).toBe(403);
    expect(code(await call('PATCH', A('/security/ssh'), { allow_groups: [] }))).toBe(
      'validation_failed',
    );
    expect((await call('PATCH', A('/security/ssh'), { port: 70000 })).status).toBe(422);
    const stale = await call('PATCH', A('/security/ssh'), { port: 2222 }, SA, {
      'If-Match': '"x"',
    });
    expect(stale.status).toBe(412);
    const job = await finish(
      await call('PATCH', A('/security/ssh'), {
        port: 2222,
        max_auth_tries: 4,
        rollback_after_sec: 60,
      }),
    );
    expect(
      data<{ steps: { op: string }[] }>(await call('GET', A(`/jobs/${job.uuid}`))).steps[0]?.op,
    ).toBe('sshd.config.apply');
    const s = data<{ port: number; max_auth_tries: number }>(await call('GET', A('/security/ssh')));
    expect([s.port, s.max_auth_tries]).toEqual([2222, 4]);
  });

  it('fail2ban: sửa jail, giữ nguyên số IP đang bị chặn', async () => {
    const jail = {
      name: 'sshd',
      enabled: true,
      bantime_sec: 7200,
      findtime_sec: 600,
      maxretry: 3,
      banned_count: 0,
    };
    expect(
      (await call('PATCH', A('/security/fail2ban'), { jails: [{ ...jail, name: 'x' }] })).status,
    ).toBe(422);
    await finish(await call('PATCH', A('/security/fail2ban'), { jails: [jail] }));
    const f = data<{ jails: { name: string; bantime_sec: number; banned_count: number }[] }>(
      await call('GET', A('/security/fail2ban')),
    );
    expect(f.jails[0]).toMatchObject({ bantime_sec: 7200, banned_count: 12 });
  });

  it('allowlist: kiểm CIDR, không cho rỗng, chống ghi đè khi dữ liệu đã đổi', async () => {
    const cur = data<{ entries: unknown[]; updated_at: string }>(
      await call('GET', A('/security/ip-allowlist')),
    );
    const put = (entries: unknown[], updated_at = cur.updated_at) =>
      call('PUT', A('/security/ip-allowlist'), { entries, updated_at });
    expect((await put([{ cidr: '10.0.0.0/33', note: '' }])).status).toBe(422);
    expect((await put([])).status).toBe(422);
    expect((await put([{ cidr: '10.1.0.0/16', note: 'VPN' }], 'old')).status).toBe(409);
    const r = await put([...cur.entries, { cidr: '10.1.0.0/16', note: 'VPN' }]);
    expect(r.status).toBe(200);
    valid('put', '/security/ip-allowlist', r);
    expect(data<{ entries: unknown[] }>(r).entries).toHaveLength(3);
  });

  it('khôi phục file cách ly một lần qua job malware.restore', async () => {
    await finish(await call('POST', A(`/security/quarantine/${QUAR}:restore`)));
    expect((await call('POST', A(`/security/quarantine/${QUAR}:restore`))).status).toBe(409);
  });
});

describe('backup & restore', () => {
  it('đích backup: kiểm cấu hình theo loại, không trả credentials, không giảm Object Lock', async () => {
    expect(
      (await call('POST', A('/backup-destinations'), { name: 'x', type: 's3', config: {} })).status,
    ).toBe(422);
    expect(
      (
        await call('POST', A('/backup-destinations'), {
          name: 'x',
          type: 'local',
          config: { path: 'rel' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await call('POST', A('/backup-destinations'), {
          name: 'x',
          type: 'local',
          config: { path: '/b' },
          immutable_days: 5,
        })
      ).status,
    ).toBe(422);
    const r = await call('POST', A('/backup-destinations'), {
      name: 'SFTP HCM',
      type: 'sftp',
      config: { host: 'bk.itso.local', path: '/srv/restic' },
      credentials: { password: 'bi-mat' },
    });
    expect(r.status).toBe(201);
    valid('post', '/backup-destinations', r);
    expect(JSON.stringify(r.body)).not.toContain('bi-mat');
    const lower = await call('PATCH', A(`/backup-destinations/${DEST_S3}`), { immutable_days: 7 });
    expect(code(lower)).toBe('immutable_locked');
    await finish(await call('POST', A(`/backup-destinations/${DEST_LOCAL}:test`)));
    expect(
      (
        await call(
          'POST',
          A('/backup-destinations'),
          { name: 'y', type: 'local', config: { path: '/y' } },
          MINH,
        )
      ).status,
    ).toBe(403);
  });

  it('chính sách: tạo, sửa, chạy ngay, xóa; lịch cron sai bị chặn', async () => {
    const input = {
      name: 'Server HN 2 mỗi 6 giờ',
      scope_type: 'server',
      scope_uuid: SRV_HN2,
      schedule: '0 */6 * * *',
      destination_uuids: [DEST_LOCAL],
      retention: { hourly: 4, daily: 7 },
    };
    expect(
      (await call('POST', A('/backup-policies'), { ...input, schedule: '99 * * * *' })).status,
    ).toBe(422);
    expect(
      (await call('POST', A('/backup-policies'), { ...input, destination_uuids: [] })).status,
    ).toBe(422);
    const r = await call('POST', A('/backup-policies'), input);
    expect(r.status).toBe(201);
    valid('post', '/backup-policies', r);
    const id = data<{ uuid: string }>(r).uuid;
    const p = await call('PATCH', A(`/backup-policies/${id}`), { enabled: false });
    expect(data<{ enabled: boolean }>(p).enabled).toBe(false);
    await finish(await call('POST', A(`/backup-policies/${POLICY}:run`)));
    const after = data<{ last_status: string }>(await call('GET', A(`/backup-policies/${POLICY}`)));
    expect(after.last_status).toBe('succeeded');
    expect((await call('DELETE', A(`/backup-policies/${id}`))).status).toBe(204);
  });

  it('backup thủ công tạo snapshot local; snapshot trên đích bất biến không xóa được', async () => {
    expect(
      (
        await call(
          'POST',
          A('/backups'),
          { hosting_account_uuid: SAOMAI, contents: ['files'] },
          MINH,
        )
      ).status,
    ).toBe(422);
    await finish(
      await call(
        'POST',
        A('/backups'),
        { hosting_account_uuid: ANPHAT, contents: ['files', 'databases'] },
        MINH,
      ),
    );
    const snaps = data<{ uuid: string; tags: string[]; destination: { uuid: string } }[]>(
      await call('GET', A(`/backup-snapshots?filter[hosting_account]=${ANPHAT}`)),
    );
    const manual = snaps.find((s) => s.tags.includes('manual'));
    expect(manual?.destination.uuid).toBe(DEST_LOCAL);
    expect(code(await call('DELETE', A(`/backup-snapshots/${SNAP_ANPHAT}`)))).toBe(
      'immutable_locked',
    );
    expect(code(await call('DELETE', A(`/backup-snapshots/${SNAP_PURGE}`)))).toBe(
      'immutable_locked',
    );
    await finish(await call('DELETE', A(`/backup-snapshots/${manual?.uuid}`)));
  });

  it('duyệt snapshot, link tải có hạn, kiểm chứng bằng restore thử', async () => {
    const root = await call('GET', A(`/backup-snapshots/${SNAP_ANPHAT}/browse?path=.`));
    valid('get', '/backup-snapshots/{id}/browse', root);
    expect(data<{ name: string }[]>(root).map((e) => e.name)).toEqual([
      'config',
      'databases',
      'sites',
    ]);
    const dbs = data<{ name: string }[]>(
      await call('GET', A(`/backup-snapshots/${SNAP_ANPHAT}/browse?path=databases`)),
    );
    expect(dbs.map((e) => e.name)).toContain('anphat_shop.sql.zst');
    expect(
      (await call('GET', A(`/backup-snapshots/${SNAP_ANPHAT}/browse?path=../etc`))).status,
    ).toBe(422);
    const link = await call('POST', A(`/backup-snapshots/${SNAP_ANPHAT}:download-link`));
    valid('post', '/backup-snapshots/{id}:download-link', link);
    await finish(await call('POST', A(`/backup-snapshots/${SNAP_ANPHAT}:verify`)));
  });

  it('restore: ghi đè phải gõ đúng username; xong thì lần khôi phục thành succeeded', async () => {
    const base = { snapshot_uuid: SNAP_ANPHAT, items: ['database:anphat_shop'] };
    expect(
      (await call('POST', A('/restores'), { ...base, mode: 'new', items: ['files:../x'] })).status,
    ).toBe(422);
    expect(
      (await call('POST', A('/restores'), { ...base, mode: 'new', items: ['shell:rm'] })).status,
    ).toBe(422);
    expect(
      code(await call('POST', A('/restores'), { ...base, mode: 'overwrite', confirm: 'x' })),
    ).toBe('confirmation_mismatch');
    expect(
      (
        await call('POST', A('/restores'), {
          ...base,
          mode: 'overwrite',
          confirm: 'anphat',
          target_server_uuid: SRV_HN2,
        })
      ).status,
    ).toBe(422);
    const r = await call('POST', A('/restores'), { ...base, mode: 'overwrite', confirm: 'anphat' });
    await finish(r);
    const list = data<{ state: string; mode: string; items: string[] }[]>(
      await call('GET', A('/restores')),
    );
    expect(list[0]).toMatchObject({ state: 'succeeded', mode: 'overwrite', items: base.items });
  });
});

describe('người dùng', () => {
  it('tạo người dùng: vai trò khớp realm, email duy nhất; ADMIN chỉ tạo user portal', async () => {
    const u = { realm: 'admin', name: 'Kế toán', email: 'kt@itso.local', role: 'USER' };
    expect((await call('POST', A('/users'), u)).status).toBe(422);
    expect((await call('POST', A('/users'), { ...u, role: 'ADMIN' }, MINH)).status).toBe(403);
    expect(
      (await call('POST', A('/users'), { ...u, role: 'ADMIN', email: 'minh.tran@itso.local' }))
        .status,
    ).toBe(409);
    const r = await call('POST', A('/users'), { ...u, role: 'ADMIN' });
    expect(r.status).toBe(201);
    valid('post', '/users', r);
    const p = await call(
      'POST',
      A('/users'),
      { realm: 'portal', name: 'KH', email: 'kh@x.vn', role: 'USER' },
      MINH,
    );
    expect(p.status).toBe(201);
  });

  it('không tự hạ quyền; luôn còn ít nhất một Super Admin', async () => {
    expect((await call('PATCH', A(`/users/${SA}`), { role: 'ADMIN' })).status).toBe(403);
    expect((await call('PATCH', A(`/users/${HAI}`), { role: 'ADMIN' })).status).toBe(200);
    expect((await call('PATCH', A(`/users/${SA}`), { role: 'ADMIN' }, HAI)).status).toBe(403);
  });

  it('khóa/mở khóa/đặt lại MFA; ADMIN chỉ thao tác user portal trong phạm vi', async () => {
    expect((await call('POST', A(`/users/${HOA}:lock`))).status).toBe(409);
    const un = await call('POST', A(`/users/${HOA}:unlock`));
    expect(data<{ status: string }>(un).status).toBe('active');
    valid('post', '/users/{id}:unlock', un);
    expect((await call('POST', A(`/users/${LAN}:lock`), {}, MINH)).status).toBe(403);
    expect((await call('POST', A(`/users/${SAOMAI_USER}:lock`), {}, MINH)).status).toBe(403);
    expect((await call('POST', A(`/users/${ANPHAT_USER}:lock`), {}, MINH)).status).toBe(200);
    expect((await call('POST', A(`/users/${MINH}:reset-mfa`), {}, MINH)).status).toBe(403);
    const mfa = await call('POST', A(`/users/${MINH}:reset-mfa`));
    expect(data<{ mfa_enabled: boolean }>(mfa).mfa_enabled).toBe(false);
  });

  it('phạm vi ADMIN: chỉ server/account có thật, ADMIN mới thấy dữ liệu theo phạm vi mới', async () => {
    expect((await call('PUT', A(`/users/${ANPHAT_USER}/scopes`), { scopes: [] })).status).toBe(422);
    expect(
      (
        await call('PUT', A(`/users/${LAN}/scopes`), {
          scopes: [{ scope_type: 'server', uuid: SA }],
        })
      ).status,
    ).toBe(422);
    const r = await call('PUT', A(`/users/${LAN}/scopes`), {
      scopes: [{ scope_type: 'server', uuid: SRV_HN2 }],
    });
    expect(r.status).toBe(200);
    valid('put', '/users/{id}/scopes', r);
    const accs = data<{ server: { uuid: string } }[]>(
      await call('GET', A('/hosting-accounts'), undefined, LAN),
    );
    expect(accs.length).toBeGreaterThan(0);
    expect(accs.every((a) => a.server.uuid === SRV_HN2)).toBe(true);
  });

  it('đăng nhập thay: cần lý do, chỉ user portal đang hoạt động, ghi audit kèm lý do', async () => {
    expect(
      (await call('POST', A(`/users/${BINHMINH_USER}:impersonate`), { reason: 'abc' })).status,
    ).toBe(422);
    expect(
      (await call('POST', A(`/users/${LAN}:impersonate`), { reason: 'Kiểm tra quyền' })).status,
    ).toBe(422);
    expect(
      (await call('POST', A(`/users/${HOA}:impersonate`), { reason: 'Hỗ trợ SSL' })).status,
    ).toBe(409);
    const r = await call('POST', A(`/users/${BINHMINH_USER}:impersonate`), {
      reason: 'Hỗ trợ cấu hình SSL',
    });
    expect(r.status).toBe(201);
    valid('post', '/users/{id}:impersonate', r);
    const log = data<{ action: string; changes: { reason?: string } }[]>(
      await call('GET', A('/audit-logs')),
    );
    expect(log[0]).toMatchObject({
      action: 'impersonation.start',
      changes: { reason: 'Hỗ trợ cấu hình SSL' },
    });
  });
});

describe('giám sát, audit, thông báo, cài đặt', () => {
  it('luật cảnh báo: kiểm ngưỡng %, không xóa luật đang có cảnh báo', async () => {
    const rule = {
      name: 'Load cao',
      metric: 'load_1m',
      scope_type: 'server',
      operator: 'gt',
      threshold: 8,
      severity: 'medium',
    };
    expect(
      (await call('POST', A('/alert-rules'), { ...rule, metric: 'cpu_pct', threshold: 150 }))
        .status,
    ).toBe(422);
    expect((await call('POST', A('/alert-rules'), rule, MINH)).status).toBe(403);
    const r = await call('POST', A('/alert-rules'), rule);
    expect(r.status).toBe(201);
    valid('post', '/alert-rules', r);
    expect((await call('DELETE', A(`/alert-rules/${RULE_CPU}`))).status).toBe(409);
    expect((await call('PATCH', A(`/alert-rules/${RULE_RAM}`), { enabled: false })).status).toBe(
      200,
    );
    expect((await call('DELETE', A(`/alert-rules/${RULE_RAM}`))).status).toBe(204);
  });

  it('xuất CSV audit log theo bộ lọc; ADMIN chỉ thấy dòng của mình', async () => {
    const res = await fetch(
      `${BASE}${A('/audit-logs/export')}?filter[action]=hosting_account.create`,
      {
        headers: { 'X-Demo-User': SA },
      },
    );
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    const rows = parseCsv(await res.text());
    expect(rows[0]?.slice(0, 5)).toEqual(['at', 'actor', 'impersonator', 'actor_ip', 'action']);
    expect(rows.length).toBe(3);
    expect(rows.slice(1).every((r) => r[4] === 'hosting_account.create')).toBe(true);
    expect(rows[1]?.[5]).toMatch(/^[a-z0-9]+$/);
    const minh = parseCsv(
      await (
        await fetch(`${BASE}${A('/audit-logs/export')}`, { headers: { 'X-Demo-User': MINH } })
      ).text(),
    );
    expect(minh.length).toBeGreaterThan(1);
    expect(minh.slice(1).every((r) => r[1] === 'minh.tran@itso.local')).toBe(true);
  });

  it('đánh dấu đã đọc một/tất cả thông báo', async () => {
    const list = async () =>
      data<{ uuid: string; read_at: string | null }[]>(
        await call('GET', A('/notifications')),
      ).filter((n) => n.read_at === null);
    const before = await list();
    expect(before.length).toBeGreaterThan(1);
    expect((await call('POST', A(`/notifications/${before[0]?.uuid}:read`))).status).toBe(204);
    expect(await list()).toHaveLength(before.length - 1);
    expect((await call('POST', A('/notifications:read-all'))).status).toBe(204);
    expect(await list()).toHaveLength(0);
  });

  it('cài đặt: chỉ SA, không tắt MFA quản trị, không lộ mật khẩu SMTP trong audit', async () => {
    expect((await call('PATCH', A('/settings/general'), { panel_name: 'X' }, MINH)).status).toBe(
      403,
    );
    expect(
      (await call('PATCH', A('/settings/security'), { admin_mfa_required: false })).status,
    ).toBe(422);
    expect((await call('PATCH', A('/settings/general'), { nope: 1 })).status).toBe(422);
    const r = await call('PATCH', A('/settings/smtp'), {
      port: 465,
      encryption: 'tls',
      password: 'smtp-bi-mat',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    const ok = await call('PATCH', A('/settings/smtp'), { port: 465, encryption: 'tls' });
    expect(data<{ values: { port: number } }>(ok).values.port).toBe(465);
    const log = await call('GET', A('/audit-logs'));
    expect(JSON.stringify(log.body)).not.toContain('smtp-bi-mat');
  });

  it('API token: secret chỉ trả một lần, hạn tối đa 1 năm, thu hồi được', async () => {
    const exp = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(
      (
        await call('POST', A('/api-tokens'), {
          name: 'ci',
          scopes: ['servers:admin'],
          expires_at: exp,
        })
      ).status,
    ).toBe(422);
    const far = new Date(Date.now() + 800 * 86_400_000).toISOString();
    expect(
      (
        await call('POST', A('/api-tokens'), {
          name: 'ci',
          scopes: ['servers:read'],
          expires_at: far,
        })
      ).status,
    ).toBe(422);
    const r = await call('POST', A('/api-tokens'), {
      name: 'ci',
      scopes: ['servers:read'],
      expires_at: exp,
    });
    expect(r.status).toBe(201);
    valid('post', '/api-tokens', r);
    const list = data<{ uuid: string; name: string }[]>(await call('GET', A('/api-tokens')));
    const t = list.find((x) => x.name === 'ci');
    expect(JSON.stringify(list)).not.toContain(data<{ secret: string }>(r).secret);
    expect((await call('DELETE', A(`/api-tokens/${t?.uuid}`))).status).toBe(204);
  });
});
