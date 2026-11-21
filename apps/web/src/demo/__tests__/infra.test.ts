// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataset } from '../dataset';
import { resetDb, setStepMs } from '../db';
import { ENROLL_JOIN_MS } from '../handlers/infra';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

const BASE = 'http://demo.local';
const SA = dataset.users.find((u) => u.role === 'SUPER_ADMIN')?.uuid ?? '';
const MINH = dataset.users.find((u) => u.role === 'ADMIN')?.uuid ?? '';
const S1 = dataset.servers[0]?.uuid ?? '';
const S2 = dataset.servers.find((s) => s.name === 'srv-hn-02')?.uuid ?? '';
const RULE = (dataset.firewall_rules as { uuid: string }[])[0]?.uuid ?? '';
const CT = (dataset.containers as { id: string }[])[0]?.id ?? '';
const COMPOSE = (dataset.compose as { uuid: string }[])[0]?.uuid ?? '';
const REG = (dataset.registries as { uuid: string }[])[0]?.uuid ?? '';
const ACC = dataset.accounts[0]?.uuid ?? '';
const STEP = 15;
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
async function finish(r: { body: unknown }) {
  const job = (r.body as { job: { uuid: string; steps: unknown[] } }).job;
  await wait(STEP * (job.steps.length + 3));
  const j = data<{ state: string }>(await call('GET', `/api/v1/admin/jobs/${job.uuid}`));
  expect(j.state).toBe('succeeded');
}

beforeAll(() => {
  setStepMs(STEP);
  demoServer.listen({ onUnhandledFrame: 'error' });
});
beforeEach(() => resetDb());
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  demoServer.close();
  setStepMs(900);
});

const rule = {
  priority: 50,
  action: 'accept',
  direction: 'in',
  protocol: 'tcp',
  ports: '8080',
  source: '10.0.0.0/8',
  comment: 'demo',
};
const yaml = 'services:\n  web:\n    image: nginx:1.27-alpine\n';

/** [method, template OpenAPI, url, body, status, user?] */
const CASES: [string, string, string, unknown, number, string?][] = [
  [
    'post',
    '/api/v1/admin/servers/enrollment-tokens',
    '/api/v1/admin/servers/enrollment-tokens',
    { name: 'srv-new-01', role_tags: ['web'], ttl_min: 60 },
    201,
  ],
  [
    'post',
    '/api/v1/admin/servers/enrollment-tokens',
    '/api/v1/admin/servers/enrollment-tokens',
    { name: 'Sai Ten' },
    422,
  ],
  [
    'post',
    '/api/v1/admin/servers/enrollment-tokens',
    '/api/v1/admin/servers/enrollment-tokens',
    { name: 'srv-hn-01' },
    409,
  ],
  [
    'post',
    '/api/v1/admin/servers/enrollment-tokens',
    '/api/v1/admin/servers/enrollment-tokens',
    { name: 'srv-x' },
    403,
    MINH,
  ],
  [
    'patch',
    '/api/v1/admin/servers/{id}',
    `/api/v1/admin/servers/${S1}`,
    { accepting_new_accounts: false },
    200,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}:reboot',
    `/api/v1/admin/servers/${S1}:reboot`,
    undefined,
    202,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/services/{service}:{action}',
    `/api/v1/admin/servers/${S1}/services/nginx:restart`,
    undefined,
    202,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/services/{service}:{action}',
    `/api/v1/admin/servers/${S1}/services/khong-co:restart`,
    undefined,
    404,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/services/{service}:{action}',
    `/api/v1/admin/servers/${S2}/services/nginx:restart`,
    undefined,
    404,
    MINH,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/software/{key}:{action}',
    `/api/v1/admin/servers/${S1}/software/nginx:install`,
    undefined,
    409,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/software/{key}:{action}',
    `/api/v1/admin/servers/${S1}/software/php8.4:install`,
    undefined,
    202,
  ],
  [
    'patch',
    '/api/v1/admin/servers/{id}/nginx',
    `/api/v1/admin/servers/${S1}/nginx`,
    { worker_connections: 8192 },
    202,
  ],
  [
    'patch',
    '/api/v1/admin/servers/{id}/nginx',
    `/api/v1/admin/servers/${S1}/nginx`,
    { worker_connections: 10 },
    422,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/firewall/rules',
    `/api/v1/admin/servers/${S1}/firewall/rules`,
    rule,
    201,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/firewall/rules',
    `/api/v1/admin/servers/${S1}/firewall/rules`,
    { ...rule, ports: 'abc' },
    422,
  ],
  [
    'delete',
    '/api/v1/admin/servers/{id}/firewall/rules/{rule}',
    `/api/v1/admin/servers/${S1}/firewall/rules/${RULE}`,
    undefined,
    204,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/firewall:apply',
    `/api/v1/admin/servers/${S1}/firewall:apply`,
    { rollback_after_sec: 10 },
    422,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/firewall:confirm',
    `/api/v1/admin/servers/${S1}/firewall:confirm`,
    undefined,
    409,
  ],
  [
    'post',
    '/api/v1/admin/servers/{id}/docker/containers/{container}:{action}',
    `/api/v1/admin/servers/${S1}/docker/containers/${CT}:restart`,
    undefined,
    202,
  ],
  [
    'post',
    '/api/v1/admin/compose-projects',
    '/api/v1/admin/compose-projects',
    { server_uuid: S1, name: 'web-demo', compose_yaml: yaml },
    202,
  ],
  [
    'post',
    '/api/v1/admin/compose-projects',
    '/api/v1/admin/compose-projects',
    { server_uuid: S1, name: 'web-demo', compose_yaml: 'x: 1' },
    422,
  ],
  [
    'patch',
    '/api/v1/admin/compose-projects/{id}',
    `/api/v1/admin/compose-projects/${COMPOSE}`,
    { compose_yaml: yaml },
    202,
  ],
  [
    'post',
    '/api/v1/admin/compose-projects/{id}:pull',
    `/api/v1/admin/compose-projects/${COMPOSE}:pull`,
    undefined,
    202,
  ],
  [
    'delete',
    '/api/v1/admin/compose-projects/{id}',
    `/api/v1/admin/compose-projects/${COMPOSE}`,
    undefined,
    202,
  ],
  [
    'post',
    '/api/v1/admin/registries',
    '/api/v1/admin/registries',
    { name: 'Harbor', url: 'https://harbor.itso.local', username: 'ci', password: 'bi-mat' },
    201,
  ],
  [
    'post',
    '/api/v1/admin/registries',
    '/api/v1/admin/registries',
    { name: 'Sai', url: 'ftp://x' },
    422,
  ],
  ['delete', '/api/v1/admin/registries/{id}', `/api/v1/admin/registries/${REG}`, undefined, 204],
  [
    'post',
    '/api/v1/admin/terminal/sessions',
    '/api/v1/admin/terminal/sessions',
    { mode: 'root', server_uuid: S1 },
    409, // policy máy chủ mặc định tắt root (D-81): 409 precondition_failed như API thật
  ],
  [
    'post',
    '/api/v1/admin/terminal/sessions',
    '/api/v1/admin/terminal/sessions',
    { mode: 'root', server_uuid: S1 },
    403,
    MINH,
  ],
  [
    'post',
    '/api/v1/admin/terminal/sessions',
    '/api/v1/admin/terminal/sessions',
    { mode: 'account', hosting_account_uuid: ACC },
    201,
  ],
];

describe('API giả lập hạ tầng (server, tường lửa, docker, compose, registry, terminal)', () => {
  it.each(CASES)('%s %s → %s', async (method, template, url, body, status, user) => {
    const r = await call(method.toUpperCase(), url, body, user ?? SA);
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    expect(validateResponse(template, method, r.status, r.body)).toEqual([]);
  });

  it('dữ liệu con tách riêng từng server: dừng nginx ở server 1 không đổi server 2', async () => {
    await finish(await call('POST', `/api/v1/admin/servers/${S1}/services/nginx:stop`));
    const svc = async (s: string) =>
      data<{ name: string; active: boolean }[]>(
        await call('GET', `/api/v1/admin/servers/${s}/services`),
      ).find((x) => x.name === 'nginx')?.active;
    expect(await svc(S1)).toBe(false);
    expect(await svc(S2)).toBe(true);
  });

  it('tường lửa safe-apply: xác nhận trong hạn thì giữ rule mới', async () => {
    await call('POST', `/api/v1/admin/servers/${S1}/firewall/rules`, rule);
    await finish(
      await call('POST', `/api/v1/admin/servers/${S1}/firewall:apply`, { rollback_after_sec: 60 }),
    );
    expect(
      (await call('POST', `/api/v1/admin/servers/${S1}/firewall:apply`, { rollback_after_sec: 60 }))
        .status,
    ).toBe(409);
    await finish(await call('POST', `/api/v1/admin/servers/${S1}/firewall:confirm`));
    const rules = data<{ ports: string }[]>(
      await call('GET', `/api/v1/admin/servers/${S1}/firewall/rules`),
    );
    expect(rules.map((r) => r.ports)).toContain('8080');
  });

  it('tường lửa safe-apply: không xác nhận thì quá hạn tự hoàn tác về bộ rule cũ', async () => {
    const before = data<unknown[]>(
      await call('GET', `/api/v1/admin/servers/${S1}/firewall/rules`),
    ).length;
    await call('POST', `/api/v1/admin/servers/${S1}/firewall/rules`, rule);
    await finish(
      await call('POST', `/api/v1/admin/servers/${S1}/firewall:apply`, { rollback_after_sec: 30 }),
    );
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    const after = data<unknown[]>(await call('GET', `/api/v1/admin/servers/${S1}/firewall/rules`));
    expect(after).toHaveLength(before);
    expect((await call('POST', `/api/v1/admin/servers/${S1}/firewall:confirm`)).status).toBe(409);
    const audit = data<{ action: string }[]>(await call('GET', '/api/v1/admin/audit-logs?limit=3'));
    expect(audit.map((a) => a.action)).toContain('firewall.rollback');
  });

  it('thêm server: sau khi tạo token, agent giả lập kết nối và server xuất hiện trong danh sách', async () => {
    await call('POST', '/api/v1/admin/servers/enrollment-tokens', {
      name: 'srv-new-01',
      role_tags: ['docker'],
    });
    const names = async () =>
      data<{ name: string }[]>(await call('GET', '/api/v1/admin/servers?limit=200')).map(
        (s) => s.name,
      );
    expect(await names()).not.toContain('srv-new-01');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + ENROLL_JOIN_MS + 100);
    expect(await names()).toContain('srv-new-01');
    const list = await call('GET', '/api/v1/admin/servers?limit=200');
    expect(validateResponse('/api/v1/admin/servers', 'get', 200, list.body)).toEqual([]);
  });

  it('compose: tạo project → job xong → trạng thái running', async () => {
    const r = await call('POST', '/api/v1/admin/compose-projects', {
      server_uuid: S1,
      name: 'web-demo',
      compose_yaml: yaml,
    });
    await finish(r);
    const id = (r.body as { resource: { uuid: string } }).resource.uuid;
    const c = data<{ status: string; compose_yaml: string }>(
      await call('GET', `/api/v1/admin/compose-projects/${id}`),
    );
    expect(c).toMatchObject({ status: 'running', compose_yaml: yaml });
  });
});
