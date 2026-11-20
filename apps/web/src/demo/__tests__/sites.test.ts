// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, setStepMs } from '../db';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

const BASE = 'http://demo.local';
const SA = '01938a01-0001-7000-8000-000001000001';
const MINH = '01938a01-0002-7000-8000-000001000002';
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const MKT = '01938a05-0002-7000-8000-000005000002';
const LEHOA = '01938a05-0003-7000-8000-000005000003';
const SAOMAI = '01938a05-0006-7000-8000-000005000006';
const GIONUI = '01938a05-0009-7000-8000-000005000009';
const SITE = '01938a06-0001-7000-8000-000006000001';
const STATIC_SITE = '01938a06-0003-7000-8000-000006000003';
const ZONE_CF = '01938a13-0001-7000-8000-000013000001';
const ZONE_MANUAL = '01938a13-0002-7000-8000-000013000002';
const CRON = '01938a0d-0001-7000-8000-00000d000001';
const REPO = '01938a2e-0001-7000-8000-00002e000001';
const DEPLOY_OLD = '01938a2f-0001-7000-8000-00002f000001';
const DEPLOY_CUR = '01938a2f-0002-7000-8000-00002f000002';
const WP_OLD = '01938a11-0001-7000-8000-000011000001';
const STEP = 10;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const A = (p: string) => `/api/v1/admin${p}`;

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
const code = (r: { body: unknown }) => (r.body as { code?: string }).code;
async function finish(r: { status: number; body: unknown }) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const job = (r.body as { job: { uuid: string; steps: unknown[] } }).job;
  await wait(STEP * (job.steps.length + 3));
  const j = data<{ state: string }>(await call('GET', A(`/jobs/${job.uuid}`)));
  expect(j.state).toBe('succeeded');
  return job;
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

describe('Website', () => {
  it('tạo website PHP → job chạy xong: website ready, domain đã xác minh, có chứng chỉ ACME', async () => {
    const r = await call('POST', A('/websites'), {
      hosting_account_uuid: ANPHAT,
      primary_domain: 'Moi.Anphat.vn',
      type: 'php',
      php_version: '8.2',
    });
    expect(validateResponse('/api/v1/admin/websites', 'post', r.status, r.body)).toEqual([]);
    const job = await finish(r);
    expect(job.steps.length).toBe(4);
    const list = data<
      { primary_domain: string; status: string; certificate_expires_at: string | null }[]
    >(await call('GET', A(`/websites?hosting_account=${ANPHAT}&per_page=50`)));
    const w = list.find((x) => x.primary_domain === 'moi.anphat.vn');
    expect(w?.status).toBe('ready');
    expect(w?.certificate_expires_at).not.toBeNull();
  });

  it.each([
    [
      'vượt số website của gói',
      { hosting_account_uuid: GIONUI, primary_domain: 'x.gionui.vn', type: 'static' },
      422,
      'package_limit_reached',
    ],
    [
      'PHP ngoài gói',
      { hosting_account_uuid: MKT, primary_domain: 'y.itso.vn', type: 'php', php_version: '8.4' },
      422,
      'package_limit_reached',
    ],
    [
      'domain đã dùng',
      { hosting_account_uuid: ANPHAT, primary_domain: 'anphat.vn', type: 'php' },
      409,
      'conflict',
    ],
    [
      'proxy ra ngoài máy chủ',
      {
        hosting_account_uuid: ANPHAT,
        primary_domain: 'p.anphat.vn',
        type: 'proxy',
        proxy_target: 'http://10.0.0.5:3000',
      },
      422,
      'validation_failed',
    ],
    [
      'document root thoát khỏi site',
      {
        hosting_account_uuid: ANPHAT,
        primary_domain: 'q.anphat.vn',
        type: 'static',
        document_root: '../../etc',
      },
      422,
      'validation_failed',
    ],
    [
      'account bị tạm ngưng',
      { hosting_account_uuid: LEHOA, primary_domain: 'z.lehoa.blog', type: 'static' },
      409,
      'invalid_state_transition',
    ],
  ])('chặn: %s', async (_, body, status, c) => {
    const r = await call('POST', A('/websites'), body);
    expect(r.status).toBe(status);
    expect(code(r)).toBe(c);
  });

  it('ADMIN ngoài phạm vi không tạo website cho account khác', async () => {
    const r = await call(
      'POST',
      A('/websites'),
      { hosting_account_uuid: SAOMAI, primary_domain: 'k.saomai.edu.vn', type: 'static' },
      MINH,
    );
    expect(r.status).toBe(422);
  });

  it('đổi PHP qua tab PHP và đọc log theo contract', async () => {
    await finish(await call('PATCH', A(`/websites/${SITE}/php`), { memory_limit: '512m' }));
    const php = await call('GET', A(`/websites/${SITE}/php`));
    expect(data<{ memory_limit: string }>(php).memory_limit).toBe('512m');
    const logs = await call('GET', A(`/websites/${SITE}/logs?kind=error&lines=20`));
    expect(
      validateResponse('/api/v1/admin/websites/{id}/logs', 'get', logs.status, logs.body),
    ).toEqual([]);
    expect(data<string[]>(logs).length).toBe(20);
  });
});

describe('File Manager', () => {
  const F = A(`/hosting-accounts/${ANPHAT}/files`);
  it('liệt kê thư mục gốc và chặn đường dẫn ngoài home', async () => {
    const root = data<{ name: string; type: string }[]>(await call('GET', `${F}?path=.`));
    expect(root.map((x) => x.name)).toContain('sites');
    expect(root[0]?.type).toBe('dir');
    for (const p of ['../', '../../etc/passwd', '/etc/passwd', '/home/mktitso']) {
      const r = await call('GET', `${F}?path=${encodeURIComponent(p)}`);
      expect(r.status, p).toBe(422);
    }
    // Đường dẫn tuyệt đối trong home được chuẩn hóa về tương đối.
    const abs = await call('GET', `${F}?path=${encodeURIComponent('/home/anphat/sites')}`);
    expect(abs.status).toBe(200);
  });

  it('lưu file với etag cũ → 412 precondition_failed', async () => {
    const path = 'sites/anphat.vn/public/index.php';
    const c = data<{ etag: string; content: string }>(
      await call('GET', `${F}/content?path=${path}`),
    );
    const ok = await call('PUT', `${F}/content`, {
      path,
      content: `${c.content}\n// sửa`,
      if_etag: c.etag,
    });
    expect(ok.status).toBe(200);
    const stale = await call('PUT', `${F}/content`, { path, content: 'x', if_etag: c.etag });
    expect(stale.status).toBe(412);
    expect(code(stale)).toBe('precondition_failed');
  });

  it('tạo thư mục, chặn chuyển thư mục vào chính nó, rồi xóa', async () => {
    await finish(await call('POST', `${F}:operate`, { op: 'mkdir', paths: ['tmp/new'] }));
    const bad = await call('POST', `${F}:operate`, {
      op: 'move',
      paths: ['tmp'],
      target: 'tmp/new',
    });
    expect(bad.status).toBe(422);
    const out = await call('POST', `${F}:operate`, { op: 'delete', paths: ['../anphat2'] });
    expect(out.status).toBe(422);
    await finish(await call('POST', `${F}:operate`, { op: 'delete', paths: ['tmp/new'] }));
    const tmp = data<unknown[]>(await call('GET', `${F}?path=tmp`));
    expect(tmp).toEqual([]);
  });
});

describe('DNS', () => {
  it('thêm record A → job xong thì có trong zone', async () => {
    await finish(
      await call('POST', A(`/dns/zones/${ZONE_CF}/records`), {
        type: 'A',
        name: 'api',
        content: '203.0.113.20',
        ttl: 300,
        proxied: true,
      }),
    );
    const rows = data<{ name: string; proxied: boolean }[]>(
      await call('GET', A(`/dns/zones/${ZONE_CF}/records?per_page=100`)),
    );
    expect(rows.find((x) => x.name === 'api')?.proxied).toBe(true);
  });
  it.each([
    ['CNAME ở gốc zone', ZONE_CF, { type: 'CNAME', name: '@', content: 'x.example.com', ttl: 300 }],
    [
      'proxy trên zone không phải Cloudflare',
      ZONE_MANUAL,
      { type: 'A', name: 'a', content: '203.0.113.1', ttl: 300, proxied: true },
    ],
    ['IPv4 sai', ZONE_CF, { type: 'A', name: 'b', content: '300.1.1.1', ttl: 300 }],
    ['MX thiếu độ ưu tiên', ZONE_CF, { type: 'MX', name: '@', content: 'mx.anphat.vn', ttl: 3600 }],
    ['TTL quá nhỏ', ZONE_CF, { type: 'TXT', name: '@', content: 'x', ttl: 5 }],
  ])('chặn: %s', async (_, zone, body) => {
    const r = await call('POST', A(`/dns/zones/${zone}/records`), body);
    expect(r.status).toBe(422);
  });
});

describe('Cron', () => {
  it.each([
    ['biểu thức sai', '61 * * * *', 'validation_failed'],
    ['dày hơn mức gói cho phép', '*/2 * * * *', 'package_limit_reached'],
  ])('chặn: %s', async (_, schedule, c) => {
    const r = await call('POST', A('/cron-jobs'), {
      hosting_account_uuid: ANPHAT,
      schedule,
      command: 'php artisan schedule:run',
    });
    expect(r.status).toBe(422);
    expect(code(r)).toBe(c);
  });
  it('chạy thủ công thêm một lần chạy vào lịch sử', async () => {
    const before = data<unknown[]>(await call('GET', A(`/cron-jobs/${CRON}/runs`))).length;
    await finish(await call('POST', A(`/cron-jobs/${CRON}:run`)));
    const runs = data<{ status: string }[]>(await call('GET', A(`/cron-jobs/${CRON}/runs`)));
    expect(runs.length).toBe(before + 1);
    expect(runs[0]?.status).toBe('succeeded');
  });
});

describe('Database, SFTP, SSH, WordPress', () => {
  it('tên database phải có tiền tố username', async () => {
    const r = await call('POST', A('/databases'), {
      hosting_account_uuid: ANPHAT,
      name: 'shop',
      engine: 'mariadb',
    });
    expect(r.status).toBe(422);
    await finish(
      await call('POST', A('/databases'), {
        hosting_account_uuid: ANPHAT,
        name: 'anphat_crm',
        engine: 'mariadb',
        create_user: true,
      }),
    );
    const users = data<{ username: string }[]>(
      await call('GET', A(`/database-users?hosting_account=${ANPHAT}`)),
    );
    expect(users.map((u) => u.username)).toContain('anphat_crm');
  });
  it('SFTP root ngoài home bị chặn; SSH key bị chặn khi gói không cho SSH', async () => {
    const r = await call('POST', A('/sftp-accounts'), {
      hosting_account_uuid: ANPHAT,
      username: 'anphat_dev',
      root_path: '../mktitso',
    });
    expect(r.status).toBe(422);
    const k = await call('POST', A('/ssh-keys'), {
      hosting_account_uuid: MKT,
      name: 'laptop',
      public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabcdefghijklmnop me@laptop',
    });
    expect(code(k)).toBe('package_limit_reached');
  });
  it('WordPress cần website PHP; cập nhật site cũ đưa về bản mới nhất', async () => {
    const r = await call('POST', A('/wordpress/sites'), {
      website_uuid: STATIC_SITE,
      title: 'x',
      admin_username: 'bao',
      admin_email: 'bao@itso.vn',
    });
    expect(r.status).toBe(422);
    await finish(await call('POST', A(`/wordpress/sites/${WP_OLD}:update`)));
    const sites = data<{ uuid: string; wp_version: string }[]>(
      await call('GET', A('/wordpress/sites?per_page=50')),
    );
    expect(sites.find((s) => s.uuid === WP_OLD)?.wp_version).toBe('6.7.1');
  });
});

describe('Git deploy', () => {
  it('deploy → release mới thành hiện hành; deploy chồng bị khóa', async () => {
    const r = await call('POST', A(`/git-repositories/${REPO}/deployments`), {});
    const again = await call('POST', A(`/git-repositories/${REPO}/deployments`), {});
    expect(again.status).toBe(409);
    expect(code(again)).toBe('resource_locked');
    await finish(r);
    const repo = data<{ current_deployment: { uuid: string } | null }>(
      await call('GET', A(`/git-repositories/${REPO}`)),
    );
    expect(repo.current_deployment?.uuid).not.toBe(DEPLOY_CUR);
  });
  it('rollback về release cũ đánh dấu các release sau là rolled_back', async () => {
    const cur = await call('POST', A(`/git-deployments/${DEPLOY_CUR}:rollback`));
    expect(cur.status).toBe(409);
    await finish(await call('POST', A(`/git-deployments/${DEPLOY_OLD}:rollback`)));
    const rows = data<{ uuid: string; state: string; trigger: string }[]>(
      await call('GET', A(`/git-repositories/${REPO}/deployments`)),
    );
    expect(rows.find((d) => d.uuid === DEPLOY_CUR)?.state).toBe('rolled_back');
    expect(rows[0]?.trigger).toBe('rollback');
  });
  it('xoay webhook secret trả secret một lần', async () => {
    const r = await call('POST', A(`/git-repositories/${REPO}:rotate-webhook-secret`));
    expect(
      validateResponse(
        '/api/v1/admin/git-repositories/{id}:rotate-webhook-secret',
        'post',
        r.status,
        r.body,
      ),
    ).toEqual([]);
  });
});
