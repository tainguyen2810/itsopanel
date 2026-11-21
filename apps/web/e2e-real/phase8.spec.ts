import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import {
  adminLogin,
  base32,
  freshTotp,
  password,
  PORTAL_EMAIL,
  SUFFIX,
  watchServerErrors,
} from './helpers';
import { createHmac } from 'node:crypto';

// Prompt 8.7: Backup & Restore trên stack thật + itso-agent --sandbox (restic THẬT, repo dưới gốc sandbox
// /var/backups/itso; MariaDB mô phỏng ở tầng lệnh: dump = nội dung đã import). Đích local → bộ khôi phục hiện một lần
// → policy → chạy ngay → snapshot → duyệt → xóa file → khôi phục file (bản mới), website (ghi đè, step-up + gõ
// username), DB (ghi đè) → so nội dung; Portal thấy và khôi phục snapshot của mình.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SBX = process.env.ITSO_SANDBOX_DIR ?? resolve(REPO, '.dev/agent-sandbox');
const FS_ROOT = resolve(SBX, 'root');
const ACCOUNT = 'anphat';
const HOME_DIR = `/home/${ACCOUNT}`;

type Realm = 'admin' | 'portal';
type Json = Record<string, unknown>;

const onServer = (p: string) => resolve(FS_ROOT, `.${p}`);
function put(p: string, content: string) {
  mkdirSync(dirname(onServer(p)), { recursive: true });
  writeFileSync(onServer(p), content);
}
const read = (p: string) => readFileSync(onServer(p), 'utf8');

/** Lệnh lịch của Laravel (scheduler không chạy trong make dev). */
function artisan(...args: string[]) {
  return execFileSync('php', ['artisan', ...args, '--no-interaction'], {
    cwd: resolve(REPO, 'apps/api'),
    encoding: 'utf8',
    env: {
      ...process.env,
      ITSO_AGENT_SOCKET: process.env.ITSO_AGENT_SOCKET ?? resolve(SBX, 'agent.sock'),
      ITSO_AGENT_KEY_FILE: process.env.ITSO_AGENT_KEY_FILE ?? resolve(SBX, 'agent.key'),
    },
  });
}

async function call(page: Page, realm: Realm, method: string, path: string, body?: unknown) {
  const xsrf = (await page.context().cookies()).find(
    (c) => c.name === `XSRF-TOKEN-${realm.toUpperCase()}`,
  )?.value;
  const res = await page.request.fetch(`/api/v1/${realm}${path}`, {
    method,
    headers: {
      'Idempotency-Key': crypto.randomUUID(),
      'X-XSRF-TOKEN': decodeURIComponent(xsrf ?? ''),
      Accept: 'application/json',
    },
    ...(body === undefined ? {} : { data: body as Json }),
  });
  const text = await res.text();
  return { status: res.status(), body: (text ? JSON.parse(text) : null) as Json };
}
const data = <T>(r: { body: Json }) => r.body.data as T;

async function job(page: Page, realm: Realm, r: { status: number; body: Json }) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const uuid = (r.body.job as { uuid: string }).uuid;
  const state = async () => {
    const j = data<{ state: string; error?: unknown }>(
      await call(page, realm, 'GET', `/jobs/${uuid}`),
    );
    return j.state === 'failed' ? `failed ${JSON.stringify(j.error)}` : j.state;
  };
  await expect.poll(state, { timeout: 90_000 }).toMatch(/^(succeeded|failed.*)$/);
  expect(await state()).toBe('succeeded');
  return r.body;
}

/** Step-up (mã TOTP chu kỳ mới) cho realm. */
async function stepUp(page: Page, realm: Realm, code: string) {
  const xsrf = (await page.context().cookies()).find(
    (c) => c.name === `XSRF-TOKEN-${realm.toUpperCase()}`,
  )?.value;
  const r = await page.request.post('/api/v1/auth/step-up', {
    headers: {
      'X-ITSO-Realm': realm,
      'X-XSRF-TOKEN': decodeURIComponent(xsrf ?? ''),
      Accept: 'application/json',
    },
    data: { method: 'totp', code },
  });
  expect(r.status(), await r.text()).toBeLessThan(300);
}

function totpOf(secret: string, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[19]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function accountUuid(page: Page, realm: Realm) {
  const r = await call(page, realm, 'GET', '/hosting-accounts?per_page=100');
  return data<{ uuid: string; username: string }[]>(r).find((x) => x.username === ACCOUNT)!.uuid;
}

const state: { site?: string; domain?: string; db?: string; dbName?: string } = {};

test.describe.configure({ mode: 'serial' });

test('Admin: đích local + bộ khôi phục một lần → policy → chạy ngay → duyệt → khôi phục file/website/DB đúng nội dung', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = watchServerErrors(page);
  await adminLogin(page);
  await stepUp(page, 'admin', await freshTotp(page));
  const acct = await accountUuid(page, 'admin');

  // Website + DB có nội dung đánh dấu (MariaDB sandbox: dump trả đúng nội dung đã import).
  const domain = `bk-${SUFFIX}.anphat.vn`;
  const site = await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', '/websites', {
      hosting_account_uuid: acct,
      primary_domain: domain,
      type: 'static',
      ssl_mode: 'none',
    }),
  );
  state.site = (site.resource as { uuid: string }).uuid;
  state.domain = domain;
  const siteDir = `${HOME_DIR}/sites/${domain}`;
  put(`${siteDir}/public/index.html`, `<h1>ban goc ${SUFFIX}</h1>\n`);
  put(`${HOME_DIR}/notes-${SUFFIX}.txt`, `ghi chu ${SUFFIX}\n`);
  const dbName = `${ACCOUNT}_bk${SUFFIX}`;
  const db = await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', '/databases', {
      hosting_account_uuid: acct,
      engine: 'mariadb',
      name: dbName,
      create_user: false,
    }),
  );
  state.db = (db.resource as { uuid: string }).uuid;
  state.dbName = dbName;
  put(`${HOME_DIR}/backups/mark-a-${SUFFIX}.sql`, `-- MARK-A ${SUFFIX}\n`);
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `/databases/${state.db}:import`, {
      path: `backups/mark-a-${SUFFIX}.sql`,
    }),
  );

  // Đích local qua UI: bộ khôi phục hiện ngay, chỉ đóng được sau khi xác nhận đã lưu.
  const existing = data<{ uuid: string; type: string }[]>(
    await call(page, 'admin', 'GET', '/backup-destinations'),
  ).find((d) => d.type === 'local');
  let dest = existing?.uuid;
  if (!dest) {
    await page.goto('/admin/backups?tab=destinations');
    await page.getByRole('button', { name: 'Thêm đích' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('combobox', { name: 'Loại' }).click();
    await page.getByRole('option', { name: 'Ổ đĩa máy chủ' }).click();
    await dlg.getByLabel('Tên đích').fill('Ổ local');
    await expect(dlg.getByText('/var/backups/itso')).toBeVisible();
    await dlg.getByRole('button', { name: 'Lưu' }).click();
    const kit = page.getByRole('dialog', { name: /Bộ khôi phục/ });
    await expect(kit).toBeVisible({ timeout: 15_000 });
    await expect(kit.getByText(/AGE-SECRET-KEY-1/)).toBeVisible();
    const done = kit.getByRole('button', { name: 'Đã lưu, đóng' });
    await expect(done).toBeDisabled();
    await kit.getByRole('checkbox', { name: /Tôi đã lưu/ }).check();
    await done.click();
    await expect(kit).toBeHidden();
    dest = data<{ uuid: string; type: string }[]>(
      await call(page, 'admin', 'GET', '/backup-destinations'),
    ).find((d) => d.type === 'local')!.uuid;
    // Đã xác nhận: xem lại không còn là "lần đầu" (và cần SUPER_ADMIN + step-up).
    const again = await call(page, 'admin', 'POST', `/backup-destinations/${dest}:recovery-kit`);
    expect(again.status === 403 || data<{ first_view: boolean }>(again).first_view === false).toBe(
      true,
    );
  }

  // Policy cho account → chạy ngay (repo init → files → DB → stats).
  const pol = await call(page, 'admin', 'POST', '/backup-policies', {
    name: `E2E ${SUFFIX}`,
    scope_type: 'hosting_account',
    scope_uuid: acct,
    contents: ['files', 'databases'],
    schedule: '15 3 * * *',
    destination_uuids: [dest],
    retention: { last: 5 },
    enabled: true,
  });
  expect(pol.status, JSON.stringify(pol.body)).toBe(201);
  const polId = data<{ uuid: string }>(pol).uuid;
  const run = await call(page, 'admin', 'POST', `/backup-policies/${polId}:run`);
  expect(run.status, JSON.stringify(run.body)).toBe(202);
  await expect
    .poll(
      async () =>
        data<{ last_status: string | null }>(
          await call(page, 'admin', 'GET', `/backup-policies/${polId}`),
        ).last_status,
      { timeout: 120_000 },
    )
    .toBe('succeeded');
  expect(existsSync(onServer('/var/backups/itso/repos')), 'repo restic dưới gốc sandbox').toBe(
    true,
  );

  const snaps = data<
    { uuid: string; scope_type: string; databases: string[]; restic_snapshot_id: string }[]
  >(
    await call(
      page,
      'admin',
      'GET',
      `/backup-snapshots?filter[hosting_account]=${acct}&per_page=100`,
    ),
  );
  const files = snaps.find((s) => s.scope_type === 'hosting_account');
  const dbSnap = snaps.find((s) => s.scope_type === 'database' && s.databases.includes(dbName));
  expect(files, JSON.stringify(snaps)).toBeTruthy();
  expect(dbSnap, JSON.stringify(snaps)).toBeTruthy();

  // Backup Center hiện snapshot; duyệt cây file qua API (đọc thật từ repo restic).
  await page.goto('/admin/backups?tab=history');
  await expect(page.getByText(files!.restic_snapshot_id.slice(0, 8)).first()).toBeVisible({
    timeout: 15_000,
  });
  const tree = data<{ name: string; type: string }[]>(
    await call(page, 'admin', 'GET', `/backup-snapshots/${files!.uuid}/browse?path=sites`),
  );
  expect(tree.map((e) => e.name)).toContain(domain);

  // Sự cố: xóa file + sửa website + đổi DB.
  rmSync(onServer(`${HOME_DIR}/notes-${SUFFIX}.txt`));
  put(`${siteDir}/public/index.html`, '<h1>bi pha</h1>\n');
  put(`${HOME_DIR}/backups/mark-b-${SUFFIX}.sql`, `-- MARK-B ${SUFFIX}\n`);
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `/databases/${state.db}:import`, {
      path: `backups/mark-b-${SUFFIX}.sql`,
    }),
  );

  // 1) File lẻ: bản mới trong backups/restore-<thời điểm>/.
  const before = new Set(
    existsSync(onServer(`${HOME_DIR}/backups`)) ? readdirSync(onServer(`${HOME_DIR}/backups`)) : [],
  );
  const rf = await call(page, 'admin', 'POST', '/restores', {
    snapshot_uuid: files!.uuid,
    mode: 'new',
    items: [`files:notes-${SUFFIX}.txt`],
  });
  expect(rf.status, JSON.stringify(rf.body)).toBe(202);
  await job(page, 'admin', rf);
  const restoreDir = readdirSync(onServer(`${HOME_DIR}/backups`)).find(
    (n) => n.startsWith('restore-') && !before.has(n),
  );
  expect(restoreDir, 'thư mục restore-<ts>').toBeTruthy();
  expect(read(`${HOME_DIR}/backups/${restoreDir}/notes-${SUFFIX}.txt`)).toBe(`ghi chu ${SUFFIX}\n`);

  // 2) Website: ghi đè qua wizard (gõ username), nội dung về bản gốc.
  await page.goto(`/admin/restores/new?snapshot=${files!.uuid}`);
  await expect(
    page.getByRole('radio', { name: new RegExp(files!.restic_snapshot_id) }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Tiếp' }).click();
  await page.getByText(domain, { exact: true }).click();
  await page.getByRole('button', { name: 'Tiếp' }).click();
  await page.getByRole('radio', { name: /Ghi đè bản đang chạy/ }).check();
  await page.getByLabel(`Gõ ${ACCOUNT} để xác nhận`).fill(ACCOUNT);
  await page.getByRole('button', { name: 'Tiếp' }).click();
  await page.getByRole('button', { name: 'Bắt đầu khôi phục' }).click();
  await expect(page).toHaveURL(/\/admin\/restores$/, { timeout: 15_000 });
  await expect
    .poll(() => read(`${siteDir}/public/index.html`), { timeout: 90_000 })
    .toBe(`<h1>ban goc ${SUFFIX}</h1>\n`);

  // 3) DB: ghi đè → export chứa MARK-A, không còn MARK-B.
  const rd = await call(page, 'admin', 'POST', '/restores', {
    snapshot_uuid: dbSnap!.uuid,
    mode: 'overwrite',
    items: [`database:${dbName}`],
    confirm: ACCOUNT,
  });
  await job(page, 'admin', rd);
  await job(page, 'admin', await call(page, 'admin', 'POST', `/databases/${state.db}:export`, {}));
  const dump = readdirSync(onServer(`${HOME_DIR}/backups`))
    .filter((n) => n.startsWith(`${dbName}-`) && n.endsWith('.sql.gz'))
    .sort()
    .at(-1);
  expect(dump, 'file export').toBeTruthy();
  const sql = gunzipSync(readFileSync(onServer(`${HOME_DIR}/backups/${dump}`))).toString('utf8');
  expect(sql).toContain(`MARK-A ${SUFFIX}`);
  expect(sql).not.toContain(`MARK-B ${SUFFIX}`);

  // Lịch sử khôi phục: 3 lần thành công, ghi đè có snapshot trước khi ghi đè.
  const list = data<{ state: string; mode: string; items: string[] }[]>(
    await call(page, 'admin', 'GET', `/restores?filter[hosting_account]=${acct}&per_page=100`),
  );
  for (const it of [`files:notes-${SUFFIX}.txt`, `files:sites/${domain}`, `database:${dbName}`]) {
    expect(list.find((r) => r.items.includes(it))?.state, it).toBe('succeeded');
  }
  // Kiểm chứng định kỳ chạy được trên repo thật (restic check + restore test).
  expect(artisan('itso:backup-verify', '--limit=2')).toMatch(/job|kiểm/i);
  expect(errors).toEqual([]);
});

test('Portal: thấy snapshot của mình, khôi phục file ra bản mới sau khi bật MFA + step-up', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const errors = watchServerErrors(page);
  await password(page, 'portal', PORTAL_EMAIL);
  await expect(page).toHaveURL(/\/portal\/?(mfa.*)?$/);
  const acct = await accountUuid(page, 'portal');
  const snaps = data<{ uuid: string; scope_type: string; hosting_account: { uuid: string } }[]>(
    await call(page, 'portal', 'GET', '/backup-snapshots?per_page=100'),
  );
  expect(snaps.length).toBeGreaterThan(0);
  expect(snaps.every((s) => s.hosting_account.uuid === acct)).toBe(true);
  await page.goto('/portal/backups');
  await expect(page.getByText('Quota backup')).toBeVisible({ timeout: 15_000 });

  const files = snaps.find((s) => s.scope_type === 'hosting_account')!;
  const body = { snapshot_uuid: files.uuid, mode: 'new', items: [`files:notes-${SUFFIX}.txt`] };
  // Khôi phục cần MFA: bật TOTP cho user Portal rồi step-up bằng mã chu kỳ sau.
  const first = await call(page, 'portal', 'POST', '/restores', body);
  expect(first.status, JSON.stringify(first.body)).toBe(403);
  const xsrf = async () =>
    decodeURIComponent(
      (await page.context().cookies()).find((c) => c.name === 'XSRF-TOKEN-PORTAL')?.value ?? '',
    );
  const headers = async () => ({
    'X-ITSO-Realm': 'portal',
    'X-XSRF-TOKEN': await xsrf(),
    Accept: 'application/json',
  });
  const enroll = await page.request.post('/api/v1/auth/mfa/totp:enroll', {
    headers: await headers(),
  });
  if (enroll.status() < 300) {
    const secret = ((await enroll.json()) as { data: { secret: string } }).data.secret;
    const conf = await page.request.post('/api/v1/auth/mfa/totp:confirm', {
      headers: await headers(),
      data: { code: totpOf(secret), method: 'totp' },
    });
    expect(conf.status(), await conf.text()).toBeLessThan(300);
    const step = Math.floor(Date.now() / 30_000);
    while (Math.floor(Date.now() / 30_000) <= step) await page.waitForTimeout(1000);
    await stepUp(page, 'portal', totpOf(secret));
  }
  const r = await call(page, 'portal', 'POST', '/restores', body);
  await job(page, 'portal', r);
  // Snapshot của account khác (không thuộc user) → 422/404.
  const other = await call(page, 'portal', 'POST', '/restores', {
    ...body,
    snapshot_uuid: '01938a99-0000-7000-8000-000000000000',
  });
  expect([404, 422]).toContain(other.status);
  expect(errors).toEqual([]);
});
