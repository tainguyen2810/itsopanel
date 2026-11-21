import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

// Helper dùng chung cho E2E stack thật (Prompt 3.6, tách ra ở 4.6).
// Tài khoản lấy từ DemoSeeder (mật khẩu và secret TOTP chỉ dùng cho môi trường dev).
export const PASSWORD = 'password-dev-only';
export const SA_EMAIL = 'superadmin@itso.local';
export const SA_TOTP = 'ITSODEVTOTPSECRETONLYFORLOCALDEV';
export const PORTAL_EMAIL = 'it@anphat.vn';
export const HOME = /\/admin\/(dashboard)?$/;
// Hậu tố ngẫu nhiên để chạy lại nhiều lần trên cùng một DB.
export const SUFFIX = Math.random().toString(36).slice(2, 7).replace(/[0-9]/g, 'x');

export function base32(s: string): Buffer {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...s].map((c) => abc.indexOf(c).toString(2).padStart(5, '0')).join('');
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

/** TOTP RFC 6238 (SHA1, 6 số, chu kỳ 30 giây). */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', base32(secret)).update(counter).digest();
  const o = h[19]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// Server chặn dùng lại mã TOTP trong cùng chu kỳ 30 giây (chống replay): mỗi lần đăng nhập chờ chu kỳ mới.
let lastStep = 0;
export async function freshTotp(page: Page): Promise<string> {
  while (Math.floor(Date.now() / 30_000) <= lastStep) await page.waitForTimeout(1000);
  lastStep = Math.floor(Date.now() / 30_000);
  return totp(SA_TOTP);
}

export async function password(page: Page, realm: 'admin' | 'portal', email: string) {
  await page.goto(`/${realm}/`);
  await expect(page).toHaveURL(new RegExp(`/${realm}/login`));
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mật khẩu').fill(PASSWORD);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
}

/** Nhập mã TOTP; nếu mã của chu kỳ này đã dùng ở lần chạy trước thì chờ chu kỳ sau và nhập lại. */
export async function submitTotp(page: Page) {
  for (let i = 0; i < 2; i++) {
    await page.locator('#mfa').fill(await freshTotp(page));
    const res = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/mfa/verify'));
    await page.getByRole('button', { name: 'Xác nhận', exact: true }).click();
    if ((await res).ok()) break;
  }
  await expect(page).toHaveURL(HOME);
}

export async function adminLogin(page: Page) {
  await password(page, 'admin', SA_EMAIL);
  await expect(page).toHaveURL(/\/admin\/login\/mfa/);
  await submitTotp(page);
}

/** Request /api trả ≥ 500 trong khi test (4xx có thể là kỳ vọng của bước kiểm tra). */
export function watchServerErrors(page: Page) {
  const errors: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}
