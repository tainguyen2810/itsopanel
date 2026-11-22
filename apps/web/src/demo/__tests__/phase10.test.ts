// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataset } from '../dataset';
import { db, resetDb, setStepMs } from '../db';
import { validateCompose } from '../handlers/docker';
import { demoServer } from '../node';
import { validateResponse } from './openapi';

const BASE = 'http://demo.local';
const SA = dataset.users.find((u) => u.role === 'SUPER_ADMIN')?.uuid ?? '';
const MINH = dataset.users.find((u) => u.role === 'ADMIN')?.uuid ?? '';
const S1 = dataset.servers[0]?.uuid ?? '';
const S2 = dataset.servers.find((s) => s.name === 'srv-hn-02')?.uuid ?? '';
const COMPOSE = dataset.compose as { uuid: string; name: string }[];
const BI = COMPOSE.find((c) => c.name === 'bi')?.uuid ?? '';
const WP = (dataset.wordpress as { uuid: string }[])[0]?.uuid ?? '';
const STEP = 15;
const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const actor = {
  uuid: SA,
  name: 'SA',
  email: 'sa@itso.local',
  role: 'SUPER_ADMIN' as const,
  realm: 'admin' as const,
};

async function call(method: string, url: string, body?: unknown, user = SA) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Demo-User': user },
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

beforeAll(() => {
  setStepMs(STEP);
  demoServer.listen({ onUnhandledFrame: 'error' });
});
beforeEach(() => resetDb());
afterAll(() => {
  demoServer.close();
  setStepMs(900);
});

describe('validator compose (mô phỏng D-96)', () => {
  const opts = { actor, at: '2026-11-22T10:00:00+07:00', nextPort: 20041 };
  it('chặn privileged, docker.sock, network host; viết lại cổng và thêm mem_limit', () => {
    const yaml =
      'services:\n  app:\n    image: nginx:1.27\n    privileged: true\n    network_mode: host\n    ports:\n      - "8080:80"\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n';
    const r = validateCompose(yaml, [], opts);
    const rules = r.v.findings.map((f) => f.rule);
    expect(rules).toEqual(
      expect.arrayContaining(['privileged', 'host_network', 'docker_socket', 'missing_limits']),
    );
    expect(r.v.ok).toBe(false);
    expect(r.v.validated_yaml).toBeNull();
    expect(r.v.rewrites).toContainEqual(
      expect.objectContaining({ before: '8080:80', after: '127.0.0.1:20041:80' }),
    );
    expect(r.v.findings.find((f) => f.rule === 'docker_socket')?.overridable).toBe(false);
  });
  it('override cap_add của SA làm project hợp lệ; YAML chạy đã viết lại', () => {
    const yaml =
      'services:\n  app:\n    image: louislam/uptime-kuma:1.23.16\n    ports:\n      - "3001"\n    cap_add:\n      - NET_RAW\n    mem_limit: 512m\n';
    expect(validateCompose(yaml, [], opts).v.ok).toBe(false);
    const r = validateCompose(
      yaml,
      [{ rule: 'cap_add', reason: 'Cần NET_RAW để ping ICMP' }],
      opts,
    );
    expect(r.v.ok).toBe(true);
    expect(r.v.overrides[0]?.rule).toBe('cap_add');
    expect(r.v.validated_yaml).toContain('127.0.0.1:20041:3001');
    expect(r.ports).toEqual([
      { service: 'app', container_port: 3001, host_port: 20041, protocol: 'tcp' },
    ]);
  });
});

describe('API giả lập Phase 10 (Docker, Compose, Software, WordPress)', () => {
  it('POST /compose-projects:validate trả ComposeValidation; ADMIN gửi override → 403', async () => {
    const yaml = 'services:\n  app:\n    image: nginx:1.27\n    privileged: true\n';
    const r = await call('POST', '/api/v1/admin/compose-projects:validate', {
      server_uuid: S1,
      compose_yaml: yaml,
      overrides: [],
    });
    expect(r.status).toBe(200);
    expect(
      validateResponse('/api/v1/admin/compose-projects:validate', 'post', 200, r.body),
    ).toEqual([]);
    expect(data<{ ok: boolean }>(r).ok).toBe(false);
    const deny = await call(
      'POST',
      '/api/v1/admin/compose-projects:validate',
      {
        server_uuid: S1,
        compose_yaml: yaml,
        overrides: [{ rule: 'privileged', reason: 'thử nghiệm nội bộ' }],
      },
      MINH,
    );
    expect(deny.status).toBe(403);
  });

  it('tạo project còn lỗi chặn → 422; hợp lệ → job và revision 1', async () => {
    const bad = await call('POST', '/api/v1/admin/compose-projects', {
      server_uuid: S1,
      name: 'thu',
      compose_yaml: 'services:\n  app:\n    image: nginx\n    privileged: true\n',
    });
    expect(bad.status).toBe(422);
    const okr = await call('POST', '/api/v1/admin/compose-projects', {
      server_uuid: S1,
      name: 'thu',
      compose_yaml:
        'services:\n  app:\n    image: nginx:1.27\n    ports:\n      - "80"\n    mem_limit: 128m\n',
      template: null,
    });
    await finish(okr);
    const list = data<
      { uuid: string; name: string; status: string; ports: { host_port: number }[] }[]
    >(await call('GET', '/api/v1/admin/compose-projects?limit=200'));
    const p = list.find((x) => x.name === 'thu');
    expect(p?.status).toBe('running');
    expect(p?.ports[0]?.host_port).toBeGreaterThanOrEqual(20000);
    const revs = data<{ number: number; current: boolean }[]>(
      await call('GET', `/api/v1/admin/compose-projects/${p?.uuid}/revisions`),
    );
    expect(revs).toEqual([expect.objectContaining({ number: 1, current: true })]);
  });

  it('cập nhật image rồi quay lại; không có bản mới → 409', async () => {
    await finish(
      await call('POST', `/api/v1/admin/compose-projects/${BI}:update-images`, {
        services: ['metabase'],
      }),
    );
    const p = data<{
      images: { service: string; update_available: boolean; rollback_available: boolean }[];
    }>(await call('GET', `/api/v1/admin/compose-projects/${BI}`));
    expect(p.images.find((i) => i.service === 'metabase')).toMatchObject({
      update_available: false,
      rollback_available: true,
    });
    expect(
      (
        await call('POST', `/api/v1/admin/compose-projects/${BI}:update-images`, {
          services: ['metabase'],
        })
      ).status,
    ).toBe(409);
    await finish(
      await call('POST', `/api/v1/admin/compose-projects/${BI}:rollback-images`, {
        services: ['metabase'],
      }),
    );
  });

  it('bật Docker trên server chưa cài (SA); ADMIN → 403; bật lại → 409', async () => {
    expect(
      data<{ state: string }>(await call('GET', `/api/v1/admin/servers/${S2}/docker`)).state,
    ).toBe('not_installed');
    expect(
      (await call('POST', `/api/v1/admin/servers/${S2}/docker:enable`, undefined, MINH)).status,
    ).toBe(403);
    await finish(await call('POST', `/api/v1/admin/servers/${S2}/docker:enable`));
    const h = data<{ state: string; checks: { ok: boolean }[] }>(
      await call('GET', `/api/v1/admin/servers/${S2}/docker`),
    );
    expect(h.state).toBe('enabled');
    expect(h.checks.every((c) => c.ok)).toBe(true);
    expect((await call('POST', `/api/v1/admin/servers/${S2}/docker:enable`)).status).toBe(409);
  });

  it('cổng compose đã cấp: trong dải 20000–29999, khớp project, không trùng', async () => {
    const r = await call('GET', `/api/v1/admin/servers/${S1}/docker/port-allocations`);
    expect(r.status).toBe(200);
    const rows = data<{ port: number; protocol: string; compose_project: { name: string } }[]>(r);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.port >= 20000 && x.port <= 29999)).toBe(true);
    expect(new Set(rows.map((x) => `${x.port}/${x.protocol}`)).size).toBe(rows.length);
    expect(rows.map((x) => x.compose_project.name)).toContain('cache');
  });
  it('volume đang dùng không xóa được (409); volume rời xóa được; prune image không tag', async () => {
    expect(
      (await call('DELETE', `/api/v1/admin/servers/${S1}/docker/volumes/cache_data`)).status,
    ).toBe(409);
    await finish(await call('DELETE', `/api/v1/admin/servers/${S1}/docker/volumes/old-test-data`));
    await finish(await call('POST', `/api/v1/admin/servers/${S1}/docker/images:prune`));
    const imgs = data<{ dangling: boolean }[]>(
      await call('GET', `/api/v1/admin/servers/${S1}/docker/images`),
    );
    expect(imgs.some((i) => i.dangling)).toBe(false);
    expect((await call('POST', `/api/v1/admin/servers/${S1}/docker/images:prune`)).status).toBe(
      409,
    );
  });

  it('Software: cài valkey khi có redis → 409; gỡ thành phần đang dùng → 409 resource_locked', async () => {
    const c = await call('POST', `/api/v1/admin/servers/${S1}/software/valkey:install`);
    expect(c.status).toBe(409);
    const r = await call('POST', `/api/v1/admin/servers/${S1}/software/nginx:remove`);
    expect(r.status).toBe(409);
    expect((r.body as { code: string }).code).toBe('resource_locked');
    await finish(await call('POST', `/api/v1/admin/servers/${S1}/software/memcached:install`));
  });

  it('OS auto-updates: SA bật/tắt; ADMIN → 403; không bao giờ auto_reboot', async () => {
    expect(
      (await call('PUT', `/api/v1/admin/servers/${S1}/os-updates`, { enabled: false }, MINH))
        .status,
    ).toBe(403);
    await finish(
      await call('PUT', `/api/v1/admin/servers/${S1}/os-updates`, {
        enabled: false,
        security_only: true,
      }),
    );
    const o = data<{ enabled: boolean; auto_reboot: boolean }>(
      await call('GET', `/api/v1/admin/servers/${S1}/os-updates`),
    );
    expect(o).toMatchObject({ enabled: false, auto_reboot: false });
  });

  it('WordPress: cập nhật chọn lọc ghi lịch sử; hardening; bảo trì; mật khẩu yếu → 422', async () => {
    await finish(
      await call('POST', `/api/v1/admin/wordpress/sites/${WP}:update`, {
        core: false,
        plugins: ['wordpress-seo'],
        themes: [],
      }),
    );
    const ups = data<{ state: string; items: { slug: string }[] }[]>(
      await call('GET', `/api/v1/admin/wordpress/sites/${WP}/updates`),
    );
    expect(ups[0]).toMatchObject({
      state: 'succeeded',
      items: [expect.objectContaining({ slug: 'wordpress-seo' })],
    });
    const d = data<{
      site: { plugins_outdated: number };
      components: { slug: string; version: string; latest_version: string | null }[];
    }>(await call('GET', `/api/v1/admin/wordpress/sites/${WP}`));
    const seo = d.components.find((c) => c.slug === 'wordpress-seo');
    expect(seo?.version).toBe(seo?.latest_version);
    expect(d.site.plugins_outdated).toBe(2);
    await finish(
      await call('POST', `/api/v1/admin/wordpress/sites/${WP}:harden`, {
        items: ['php_in_uploads_blocked'],
        enabled: true,
      }),
    );
    await finish(
      await call('POST', `/api/v1/admin/wordpress/sites/${WP}:maintenance`, { enabled: true }),
    );
    const s = data<{ site: { maintenance: boolean; hardening: Record<string, boolean> } }>(
      await call('GET', `/api/v1/admin/wordpress/sites/${WP}`),
    );
    expect(s.site.maintenance).toBe(true);
    expect(s.site.hardening.php_in_uploads_blocked).toBe(true);
    expect(
      (
        await call('POST', `/api/v1/admin/wordpress/sites/${WP}:admin-password`, {
          password: 'ngan',
        })
      ).status,
    ).toBe(422);
    await finish(
      await call('POST', `/api/v1/admin/wordpress/sites/${WP}:admin-password`, {
        password: 'N3w-Strong.Pass2026',
      }),
    );
    const p = await call('PATCH', `/api/v1/admin/wordpress/sites/${WP}`, {
      auto_update: 'all',
      update_window: '01:00-04:00',
    });
    expect(p.status).toBe(200);
    expect(validateResponse('/api/v1/admin/wordpress/sites/{id}', 'patch', 200, p.body)).toEqual(
      [],
    );
  });
  it('WordPress như API: cài trả mật khẩu quản trị một lần; staging basic auth → 422; chưa có đích backup → 409', async () => {
    const wpSites = new Set(
      (dataset.wordpress as { website: { uuid: string } }[]).map((w) => w.website.uuid),
    );
    const free = dataset.websites.find((w) => w.type === 'php' && !wpSites.has(w.uuid));
    expect(free).toBeDefined();
    const body = {
      website_uuid: free?.uuid,
      title: 'Thử',
      admin_username: 'quantri',
      admin_email: 'qt@example.vn',
      locale: 'vi',
    };
    expect(
      (await call('POST', '/api/v1/admin/wordpress/sites', { ...body, admin_username: 'admin' }))
        .status,
    ).toBe(422);
    const r = await call('POST', '/api/v1/admin/wordpress/sites', body);
    const secret = (r.body as { secret?: string }).secret ?? '';
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect((r.body as { job: { resource: { type: string } } }).job.resource.type).toBe(
      'wordpress_site',
    );
    await finish(r);
    const job = (r.body as { job: { uuid: string } }).job.uuid;
    expect(JSON.stringify(await call('GET', `/api/v1/admin/jobs/${job}`))).not.toContain(secret);

    const stg = await call('POST', `/api/v1/admin/wordpress/sites/${WP}:clone-staging`, {
      subdomain: 'stg',
      basic_auth: true,
    });
    expect(stg.status).toBe(422);
    db().data.backup_dests = [];
    const u = await call('POST', `/api/v1/admin/wordpress/sites/${WP}:update`, { core: true });
    expect(u.status).toBe(409);
    expect((u.body as { code: string }).code).toBe('precondition_failed');
  });
});
