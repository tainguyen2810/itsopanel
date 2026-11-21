import { describe, expect, it, vi } from 'vitest';
import { solveCaptcha } from '../captcha';
import { leadingZeroBits, powHash, powValid } from '../pow';

// 7.6: CAPTCHA chạy trong Web Worker ở trình duyệt; môi trường test không có Worker nên giải trên luồng chính
// cùng một hàm solvePow. Định dạng khớp API thật (App\Auth\Captcha::solves): sha256("challenge:nonce").
describe('CAPTCHA proof-of-work (worker)', () => {
  it('không có Worker → giải trên luồng chính, lời giải hợp lệ, báo tiến độ', async () => {
    expect(typeof Worker).toBe('undefined');
    const progress = vi.fn();
    const ch = 'eyJyIjoiYWJjIiwicmVhbG0iOiJwb3J0YWwiLCJlIjoxNzYzNjAxMzAwLCJkIjoxMH0.sig';
    const nonce = await solveCaptcha(ch, 10, progress).promise;
    expect(await powValid(ch, nonce, 10)).toBe(true);
    expect(leadingZeroBits(await powHash(ch, nonce))).toBeGreaterThanOrEqual(10);
    // 10 bit cần trung bình ~1024 lần thử: thường có ít nhất một lần báo tiến độ (mỗi 1024 lần), không bắt buộc.
    expect(progress.mock.calls.every(([n]) => typeof n === 'number' && n % 1024 === 0)).toBe(true);
  });
  it('hủy (rời trang, lấy thử thách mới) dừng việc giải', async () => {
    const job = solveCaptcha('v1.cancel', 30);
    job.cancel();
    await expect(job.promise).rejects.toThrow(/aborted/);
  });
  it('nonce phải là số thập phân ≤ 12 chữ số như API kiểm', async () => {
    expect(await powValid('v1.x', '-1', 0)).toBe(false);
    expect(await powValid('v1.x', '1234567890123', 0)).toBe(false);
    expect(await powValid('v1.x', '42', 0)).toBe(true);
  });
});
