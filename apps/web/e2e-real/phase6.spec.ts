import { generateKeyPairSync } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  adminLogin,
  freshTotp,
  password,
  PORTAL_EMAIL,
  SUFFIX,
  watchServerErrors,
} from './helpers';

// Prompt 6.6: stack thật + itso-agent --sandbox (MariaDB/pure-ftpd/sshd mô phỏng ở tầng lệnh, file thật dưới gốc
// sandbox, terminal qua itso-gateway với shell giả). Database + user → export → import; File Manager (thư mục,
// upload tiếp tục được, sửa, nén/giải nén, tải về); FTP phụ + khóa SSH; cron → chạy ngay → lịch sử; terminal;
// Portal làm tương tự trên account của mình.

const ACCOUNT = 'anphat';
type Realm = 'admin' | 'portal';
type Json = Record<string, unknown>;

/** Khóa ed25519 thật dạng OpenSSH (blob = string "ssh-ed25519" + string khóa 32 byte). */
function sshKey(): string {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x as string, 'base64url');
  const str = (b: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  const blob = Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]);
  return `ssh-ed25519 ${blob.toString('base64')} e2e@itso`;
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

async function accountUuid(page: Page, realm: Realm): Promise<string> {
  const r = await call(page, realm, 'GET', '/hosting-accounts?per_page=100');
  const a = (r.body.data as { uuid: string; username: string }[]).find(
    (x) => x.username === ACCOUNT,
  );
  expect(a, ACCOUNT).toBeTruthy();
  return a!.uuid;
}

/** 202 → chờ job succeeded; trả JobAccepted. */
async function job(page: Page, realm: Realm, r: { status: number; body: Json }) {
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  const uuid = (r.body.job as { uuid: string }).uuid;
  await expect
    .poll(
      async () =>
        ((await call(page, realm, 'GET', `/jobs/${uuid}`)).body.data as { state: string }).state,
      // failed cũng dừng chờ: toBe báo ngay giá trị sai.
      { timeout: 60_000 },
    )
    .toBe('succeeded');
  return r.body;
}

async function names(page: Page, realm: Realm, acct: string, dir: string) {
  const r = await call(page, realm, 'GET', `/hosting-accounts/${acct}/files?path=${dir}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body.data as { name: string }[]).map((x) => x.name);
}

/** Database + user cùng tên → export (.sql.gz trong backups/) → import lại từ file đó. */
async function databaseFlow(page: Page, realm: Realm, acct: string, name: string) {
  const created = await job(
    page,
    realm,
    await call(page, realm, 'POST', '/databases', {
      hosting_account_uuid: acct,
      engine: 'mariadb',
      name,
      create_user: true,
    }),
  );
  expect(created.secret, 'mật khẩu sinh trả một lần').toEqual(expect.any(String));
  const id = (created.resource as { uuid: string }).uuid;
  const db = (await call(page, realm, 'GET', `/databases/${id}`)).body.data as Json;
  expect(db.status).toBe('ready');
  expect(db.users).toEqual([name]);
  await job(page, realm, await call(page, realm, 'POST', `/databases/${id}:export`, {}));
  const dump = (await names(page, realm, acct, 'backups')).find(
    (n) => n.startsWith(`${name}-`) && n.endsWith('.sql.gz'),
  );
  expect(dump, 'file export').toBeTruthy();
  await job(
    page,
    realm,
    await call(page, realm, 'POST', `/databases/${id}:import`, { path: `backups/${dump}` }),
  );
  return id;
}

test.describe.configure({ mode: 'serial' });

test('Admin: database + user → export → import; FTP phụ + khóa SSH; cron chạy ngay', async ({
  page,
}) => {
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const acct = await accountUuid(page, 'admin');

  // Database qua UI: tạo kèm user → job → mật khẩu hiện một lần.
  const name = `${ACCOUNT}_e2e${SUFFIX}`;
  await page.goto('/admin/databases');
  await page.getByRole('button', { name: 'Thêm database' }).click();
  const dlg = page.getByRole('dialog', { name: 'Thêm database' });
  await dlg.getByRole('combobox', { name: 'Tài khoản' }).click();
  await page.getByRole('option', { name: new RegExp(`^${ACCOUNT}`) }).click();
  await dlg.getByLabel('Tên database').fill(name);
  await expect(dlg.getByRole('switch', { name: 'Tạo user cùng tên' })).toBeChecked();
  await dlg.getByRole('button', { name: 'Tạo' }).click();
  const secret = page.getByRole('dialog', { name: 'Mật khẩu mới' });
  await expect(secret).toBeVisible({ timeout: 15_000 });
  await secret.getByRole('button').first().press('Escape');
  await expect(page.getByText(`Đã xong: `).first()).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');

  // Export → import qua job với database thứ hai (API).
  await databaseFlow(page, 'admin', acct, `${ACCOUNT}_x${SUFFIX}`);

  // FTP phụ (mật khẩu sinh) + đổi mật khẩu; khóa SSH (gói business có SSH).
  const ftp = await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', '/sftp-accounts', {
      hosting_account_uuid: acct,
      username: `${ACCOUNT}_f${SUFFIX}`,
      protocol: 'ftps',
      root_path: '.',
      password: null,
    }),
  );
  expect(ftp.secret).toEqual(expect.any(String));
  const ftpId = (ftp.resource as { uuid: string }).uuid;
  const rot = await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `/sftp-accounts/${ftpId}:rotate-password`, {}),
  );
  expect(rot.secret).toEqual(expect.any(String));
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', '/ssh-keys', {
      hosting_account_uuid: acct,
      name: `e2e ${SUFFIX}`,
      public_key: sshKey(),
    }),
  );

  // Cron: tạo → chạy ngay → lịch sử có một lần chạy thành công.
  const cron = await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', '/cron-jobs', {
      hosting_account_uuid: acct,
      schedule: '*/30 * * * *',
      command: `echo e2e-${SUFFIX}`,
      working_dir: '.',
      enabled: true,
    }),
  );
  const cronId = (cron.resource as { uuid: string }).uuid;
  await job(page, 'admin', await call(page, 'admin', 'POST', `/cron-jobs/${cronId}:run`, {}));
  const runs = (await call(page, 'admin', 'GET', `/cron-jobs/${cronId}/runs`)).body.data as Json[];
  expect(runs[0]?.status).toBe('succeeded');
  await page.goto('/admin/cron');
  await page
    .getByRole('button', { name: `Thao tác cho cron echo e2e-${SUFFIX}` })
    .click({ timeout: 15_000 });
  await page.getByRole('menuitem', { name: 'Lịch sử chạy' }).click();
  await expect(page.getByRole('dialog', { name: 'Lịch sử chạy' })).toContainText('Thành công');
  expect(errors).toEqual([]);
});

test('Admin: File Manager thư mục, upload tiếp tục được, sửa, nén/giải nén, tải về', async ({
  page,
}) => {
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const acct = await accountUuid(page, 'admin');
  const dir = `e2e-${SUFFIX}`;
  const files = `/hosting-accounts/${acct}/files`;
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `${files}:operate`, { op: 'mkdir', paths: [dir] }),
  );

  // Upload tiếp tục được: gửi nửa đầu, gửi lặp lại bị 409 kèm vị trí đúng, gửi nửa sau → commit qua job.
  const up = await call(page, 'admin', 'POST', `${files}/uploads`, {
    path: `${dir}/resume.txt`,
    size: 10,
  });
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const upId = (up.body.data as { uuid: string }).uuid;
  const xsrf = (await page.context().cookies()).find((c) => c.name === 'XSRF-TOKEN-ADMIN')?.value;
  const chunk = (range: string, data: string) =>
    page.request.patch(`/api/v1/admin${files}/uploads/${upId}`, {
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Content-Range': range,
        'X-XSRF-TOKEN': decodeURIComponent(xsrf ?? ''),
      },
      data: Buffer.from(data),
    });
  expect((await chunk('bytes 0-4/10', 'hello')).status()).toBe(200);
  const again = await chunk('bytes 0-4/10', 'hello');
  expect(again.status()).toBe(409);
  expect(((await again.json()) as { errors: { received: string[] } }).errors.received).toEqual([
    '5',
  ]);
  expect((await chunk('bytes 5-9/10', 'world')).status()).toBe(200);
  await expect
    .poll(
      async () =>
        ((await call(page, 'admin', 'GET', `${files}/uploads/${upId}`)).body.data as Json).status,
      { timeout: 30_000 },
    )
    .toBe('completed');

  // Upload qua UI (Uploader chunk) rồi thấy file trong thư mục.
  await page.goto(`/admin/files?account=${acct}&path=${dir}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'ui.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('tai len tu giao dien\n'),
  });
  await expect(page.getByRole('region', { name: 'Đang tải lên' }).getByText('Xong')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: 'ui.txt', exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Sửa file trong trình soạn thảo (ETag).
  await page.getByRole('button', { name: 'resume.txt', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'resume.txt' });
  const box = editor.getByLabel('Nội dung file');
  await expect(box).toContainText('helloworld');
  await box.fill('da sua');
  await editor.getByRole('button', { name: 'Lưu' }).click();
  await expect(page.getByText('Đã lưu file')).toBeVisible();
  const content = await call(page, 'admin', 'GET', `${files}/content?path=${dir}/resume.txt`);
  expect((content.body.data as { content: string }).content).toBe('da sua');

  // Nén → giải nén vào thư mục khác.
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `${files}:operate`, {
      op: 'compress',
      paths: [`${dir}/resume.txt`, `${dir}/ui.txt`],
      target: `${dir}/pack.zip`,
      format: 'zip',
    }),
  );
  await job(
    page,
    'admin',
    await call(page, 'admin', 'POST', `${files}:operate`, {
      op: 'extract',
      paths: [`${dir}/pack.zip`],
      target: `${dir}/out`,
    }),
  );
  expect(await names(page, 'admin', acct, `${dir}/out`)).toEqual(
    expect.arrayContaining(['resume.txt', 'ui.txt']),
  );

  // Tải về qua link ký (5 phút, gắn user).
  const link = await call(page, 'admin', 'GET', `${files}/download?path=${dir}/resume.txt`);
  const url = (link.body.data as { url: string }).url;
  const dl = await page.request.get(url);
  expect(dl.status()).toBe(200);
  expect(await dl.text()).toBe('da sua');
  expect((await page.request.get(url.replace(/signature=[^&]+/, 'signature=x'))).status()).toBe(
    403,
  );
  expect(errors).toEqual([]);
});

test('Admin: terminal mở và nhận output dưới user của account', async ({ page }) => {
  const errors = watchServerErrors(page);
  await adminLogin(page);
  const acct = await accountUuid(page, 'admin');
  const a = (await call(page, 'admin', 'GET', `/hosting-accounts/${acct}`)).body.data as {
    server: { uuid: string };
  };
  // Terminal account mở từ trang server chứa account (chế độ mặc định: uid của account).
  await page.goto(`/admin/servers/${a.server.uuid}/terminal`);
  await page.getByRole('combobox', { name: 'Tài khoản hosting' }).click();
  await page.getByRole('option', { name: new RegExp(`^${ACCOUNT}`) }).click();
  await page.getByRole('button', { name: 'Kết nối' }).click();
  // Mở terminal là thao tác nhạy cảm: step-up TOTP rồi gửi lại.
  const stepUp = page.getByRole('dialog', { name: 'Xác thực lại để tiếp tục' });
  await expect(stepUp).toBeVisible();
  await stepUp.getByLabel('Mã 6 số').fill(await freshTotp(page));
  await stepUp.getByRole('button', { name: 'Xác nhận và tiếp tục' }).click();
  const term = page.locator('.xterm');
  await expect(term).toBeVisible({ timeout: 15_000 });
  await expect(term.locator('.xterm-rows')).toContainText('$', { timeout: 15_000 });
  await term.click();
  await page.keyboard.type('whoami');
  await page.keyboard.press('Enter');
  await expect(term.locator('.xterm-rows')).toContainText(ACCOUNT, { timeout: 10_000 });
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Phiên đã kết thúc')).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);
});

test('Portal: database, file, cron trên account của mình', async ({ page }) => {
  const errors = watchServerErrors(page);
  await password(page, 'portal', PORTAL_EMAIL);
  await expect(page).toHaveURL(/\/portal\/?$/);
  const acct = await accountUuid(page, 'portal');
  await databaseFlow(page, 'portal', acct, `${ACCOUNT}_p${SUFFIX}`);
  const dir = `portal-${SUFFIX}`;
  await job(
    page,
    'portal',
    await call(page, 'portal', 'POST', `/hosting-accounts/${acct}/files:operate`, {
      op: 'mkdir',
      paths: [dir],
    }),
  );
  expect(await names(page, 'portal', acct, '.')).toContain(dir);
  // Ngoài home bị chặn.
  const out = await call(page, 'portal', 'GET', `/hosting-accounts/${acct}/files?path=../../etc`);
  expect(out.status).toBe(422);
  const cron = await job(
    page,
    'portal',
    await call(page, 'portal', 'POST', '/cron-jobs', {
      hosting_account_uuid: acct,
      schedule: '0 3 * * *',
      command: `echo portal-${SUFFIX}`,
      working_dir: '.',
      enabled: true,
    }),
  );
  const cronId = (cron.resource as { uuid: string }).uuid;
  await job(page, 'portal', await call(page, 'portal', 'POST', `/cron-jobs/${cronId}:run`, {}));
  await page.goto(`/portal/files?account=${acct}`);
  await expect(page.getByRole('table').getByRole('button', { name: dir, exact: true })).toBeVisible(
    {
      timeout: 15_000,
    },
  );
  expect(errors).toEqual([]);
});
