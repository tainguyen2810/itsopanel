import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

// Prompt 3.6: luồng chính trên stack thật (Laravel + PostgreSQL + Redis + mock agent).
// Tài khoản lấy từ DemoSeeder (mật khẩu và secret TOTP chỉ dùng cho môi trường dev).
const PASSWORD = 'password-dev-only';
const SA_EMAIL = 'superadmin@itso.local';
const SA_TOTP = 'ITSODEVTOTPSECRETONLYFORLOCALDEV';
const PORTAL_EMAIL = 'it@anphat.vn';
const HOME = /\/admin\/(dashboard)?$/;
// Hậu tố ngẫu nhiên để chạy lại nhiều lần trên cùng một DB.
const SUFFIX = Math.random().toString(36).slice(2, 7).replace(/[0-9]/g, 'x');

function base32(s: string): Buffer {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...s].map((c) => abc.indexOf(c).toString(2).padStart(5, '0')).join('');
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

/** TOTP RFC 6238 (SHA1, 6 số, chu kỳ 30 giây). */
function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[19]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// Server chặn dùng lại mã TOTP trong cùng chu kỳ 30 giây (chống replay): mỗi lần đăng nhập chờ chu kỳ mới.
let lastStep = 0;
async function freshTotp(page: Page): Promise<string> {
  while (Math.floor(Date.now() / 30_000) <= lastStep) await page.waitForTimeout(1000);
  lastStep = Math.floor(Date.now() / 30_000);
  return totp(SA_TOTP);
}

async function password(page: Page, realm: 'admin' | 'portal', email: string) {
  await page.goto(`/${realm}/`);
  await expect(page).toHaveURL(new RegExp(`/${realm}/login`));
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
}

/** Nhập mã TOTP; nếu mã của chu kỳ này đã dùng ở lần chạy trước thì chờ chu kỳ sau và nhập lại. */
async function submitTotp(page: Page) {
  for (let i = 0; i < 2; i++) {
    await page.locator('#mfa').fill(await freshTotp(page));
    const res = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/mfa/verify'));
    await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
    if ((await res).ok()) break;
  }
  await expect(page).toHaveURL(HOME);
}

async function adminLogin(page: Page) {
  await password(page, 'admin', SA_EMAIL);
  await expect(page).toHaveURL(/\/admin\/login\/mfa/);
  await submitTotp(page);
}

/** Request /api trả ≥ 500 trong khi test (4xx có thể là kỳ vọng của bước kiểm tra). */
function watchServerErrors(page: Page) {
  const errors: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('Admin: đăng nhập có MFA (mã sai bị từ chối), Hồ sơ đúng người', async ({ page }) => {
  const errors = watchServerErrors(page);
  await password(page, 'admin', SA_EMAIL);
  await expect(page).toHaveURL(/\/admin\/login\/mfa/);
  // Chưa xác minh MFA thì vào route có shell bị đưa về bước MFA.
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/admin\/login\/mfa/);
  const wrong = totp(SA_TOTP) === '000000' ? '111111' : '000000';
  await page.locator('#mfa').fill(wrong);
  await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(page.getByText('Mã không đúng')).toBeVisible();
  await submitTotp(page);
  await page.goto('/admin/profile');
  await expect(page.getByText(SA_EMAIL)).toBeVisible();
  expect(errors).toEqual([]);
});

test('Admin: tạo user portal, tạo gói, tạo account → job → hoạt động, khóa rồi mở khóa', async ({
  page,
}) => {
  const errors = watchServerErrors(page);
  await adminLogin(page);

  // 1. User portal mới.
  const ownerName = `E2E Owner ${SUFFIX}`;
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Thêm người dùng' }).click();
  const dlg = page.getByRole('dialog', { name: 'Thêm người dùng' });
  await dlg.getByLabel('Họ tên / tên đơn vị').fill(ownerName);
  await dlg.getByRole('textbox', { name: 'Email' }).fill(`e2e-${SUFFIX}@example.vn`);
  await dlg.getByRole('button', { name: 'Tạo người dùng' }).click();
  await expect(page.getByText('Đã tạo người dùng')).toBeVisible();
  await expect(
    page.getByRole('cell', { name: `${ownerName} e2e-${SUFFIX}@example.vn` }),
  ).toBeVisible();

  // 2. Gói mới.
  const code = `e2e-${SUFFIX}`;
  await page.goto('/admin/hosting-packages/new');
  await page.getByLabel('Mã gói').fill(code);
  await page.getByLabel('Tên gói').fill(`E2E ${SUFFIX}`);
  await page.getByRole('button', { name: 'Tạo gói' }).click();
  await expect(page.getByText('Đã tạo gói hosting')).toBeVisible();

  // 3. Account cho user mới với gói mới → job chạy qua mock agent → Hoạt động.
  const username = `e2e${SUFFIX}`;
  await page.goto('/admin/hosting-accounts/new');
  const next = page.getByRole('button', { name: 'Tiếp' });
  await page.getByRole('combobox', { name: 'Chủ sở hữu' }).click();
  await page.getByRole('option', { name: new RegExp(ownerName) }).click();
  await next.click();
  await page.getByRole('radio', { name: new RegExp(`E2E ${SUFFIX}`) }).check();
  await next.click();
  await page.getByRole('radio', { name: /srv-local/ }).check();
  await next.click();
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel(/Domain chính/).fill(`${username}.example.vn`);
  await next.click();
  await expect(page.getByRole('heading', { name: 'Xác nhận' })).toBeVisible();
  await page.getByRole('button', { name: 'Tạo tài khoản' }).click();
  await expect(page.getByText('Đã xong: Tạo tài khoản hosting')).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: username })).toBeVisible();
  await expect(page.getByText('Hoạt động').first()).toBeVisible({ timeout: 15_000 });

  // 4. Khóa → Tạm khóa; mở khóa → Hoạt động.
  await page.getByRole('button', { name: 'Thao tác' }).click();
  await page.getByRole('menuitem', { name: 'Tạm khóa' }).click();
  const lock = page.getByRole('dialog', { name: `Tạm khóa ${username}?` });
  await lock.getByLabel('Lý do').fill('Kiểm thử e2e: tạm khóa');
  await lock.getByRole('button', { name: 'Tạm khóa' }).click();
  // Trạng thái mong muốn đổi ngay; chờ job xong rồi mới thao tác tiếp (một account chỉ một job chạy).
  await expect(page.getByText('Tài khoản đang bị tạm khóa')).toBeVisible();
  await expect(page.getByText('Đã xong: Tạm khóa tài khoản hosting')).toBeVisible({
    timeout: 30_000,
  });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Thao tác' }).click();
  await page.getByRole('menuitem', { name: 'Mở khóa' }).click();
  const unlock = page.getByRole('alertdialog', { name: `Mở khóa ${username}?` });
  await unlock.getByRole('button', { name: 'Mở khóa' }).click();
  await expect(page.getByText('Đã xong: Mở khóa tài khoản hosting')).toBeVisible({
    timeout: 30_000,
  });
  await page.keyboard.press('Escape');
  await expect(page.getByText('Tài khoản đang bị tạm khóa')).toBeHidden();
  await expect(page.getByText('Hoạt động').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Portal: chỉ thấy account của mình, URL account người khác bị chặn', async ({
  page,
  browser,
}) => {
  // Lấy uuid account của người khác (mktitso) bằng phiên Admin ở context riêng.
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await adminLogin(admin);
  const other = await admin.evaluate(async () => {
    const r = await fetch('/api/v1/admin/hosting-accounts?q=mktitso', {
      headers: { 'X-ITSO-Realm': 'admin', Accept: 'application/json' },
    });
    const body = (await r.json()) as { data: { uuid: string; username: string }[] };
    return body.data.find((a) => a.username === 'mktitso')?.uuid ?? '';
  });
  await adminCtx.close();
  expect(other).not.toBe('');

  const errors = watchServerErrors(page);
  await password(page, 'portal', PORTAL_EMAIL);
  await expect(page).toHaveURL(/\/portal\/?$/);
  await expect(page.getByText('Công ty An Phát').first()).toBeVisible();
  await expect(page.getByText('anphat').first()).toBeVisible();
  await expect(page.getByText('mktitso')).toHaveCount(0);
  await expect(page.getByText('lehoa')).toHaveCount(0);

  // API: danh sách chỉ có account của chủ sở hữu; account người khác trả 404 (không lộ là có tồn tại).
  const result = await page.evaluate(async (id) => {
    const h = { 'X-ITSO-Realm': 'portal', Accept: 'application/json' };
    const list = await fetch('/api/v1/portal/hosting-accounts', { headers: h });
    const one = await fetch(`/api/v1/portal/hosting-accounts/${id}`, { headers: h });
    const body = (await list.json()) as { data: { username: string }[] };
    return { names: body.data.map((a) => a.username).sort(), other: one.status };
  }, other);
  expect(result.names).toEqual(['anphat', 'oldshop']);
  expect(result.other).toBe(404);

  // Giao diện: mở thẳng URL account người khác không hiện dữ liệu.
  await page.goto(`/portal/accounts/${other}`);
  await expect(page.getByText('mktitso')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Không tìm thấy');
  expect(errors).toEqual([]);
});

test('Sai realm bị từ chối: phiên Portal không gọi được API Admin, trang Admin đòi đăng nhập', async ({
  page,
}) => {
  await password(page, 'portal', PORTAL_EMAIL);
  await expect(page).toHaveURL(/\/portal\/?$/);
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/v1/admin/users', {
      headers: { 'X-ITSO-Realm': 'admin', Accept: 'application/json' },
    });
    return r.status;
  });
  expect(status).toBe(401);
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/admin\/login/);

  // Người dùng portal không đăng nhập được vào Admin Panel.
  await page.getByLabel('Email').fill(PORTAL_EMAIL);
  await page.getByLabel('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/login/);
});
