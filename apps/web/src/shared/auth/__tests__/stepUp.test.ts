import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/http';
import { sendWith, type AnyClient } from '@/shared/api/core';
import { setStepUpHandler, STEP_UP_PATH } from '../stepUp';

const reply = (status: number, body: unknown) => ({
  error: status >= 400 ? JSON.stringify(body) : undefined,
  data: status < 400 ? JSON.stringify(body) : undefined,
  response: new Response(null, { status: status === 204 ? 204 : 200 }),
});
const stepUpProblem = {
  type: 'about:blank',
  title: 'Cần xác thực lại',
  status: 403,
  code: 'mfa_step_up_required',
};

/** Client giả: trả lần lượt các phản hồi trong `queue`, ghi lại Idempotency-Key mỗi lần gọi. */
function client(queue: { status: number; body: unknown }[]) {
  const keys: string[] = [];
  const fn = vi.fn((_path: string, init: { headers: Record<string, string> }) => {
    keys.push(init.headers['Idempotency-Key'] ?? '');
    const r = queue.shift() ?? { status: 500, body: { title: 'hết' } };
    return Promise.resolve({
      ...reply(r.status, r.body),
      response: new Response(null, { status: r.status === 204 ? 204 : r.status }),
    });
  });
  return {
    c: { POST: fn, DELETE: fn, PUT: fn, PATCH: fn, GET: fn } as unknown as AnyClient,
    fn,
    keys,
  };
}

afterEach(() => setStepUpHandler(null));

describe('step-up MFA trong sendWith', () => {
  it('403 mfa_step_up_required → hỏi mã → gửi lại đúng một lần với key mới', async () => {
    const ask = vi.fn(() => Promise.resolve(true));
    setStepUpHandler(ask);
    const { c, fn, keys } = client([
      { status: 403, body: stepUpProblem },
      { status: 204, body: null },
    ]);
    await expect(sendWith(c, 'DELETE', '/api/v1/admin/websites/{id}')).resolves.toBeUndefined();
    expect(ask).toHaveBeenCalledOnce();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('người dùng hủy hoặc không có hộp thoại → ném lỗi gốc, không gửi lại', async () => {
    setStepUpHandler(() => Promise.resolve(false));
    const a = client([{ status: 403, body: stepUpProblem }]);
    await expect(sendWith(a.c, 'DELETE', '/x')).rejects.toBeInstanceOf(ApiError);
    expect(a.fn).toHaveBeenCalledOnce();

    setStepUpHandler(null);
    const b = client([{ status: 403, body: stepUpProblem }]);
    await expect(sendWith(b.c, 'DELETE', '/x')).rejects.toMatchObject({
      problem: { code: 'mfa_step_up_required' },
    });
  });

  it('chính request step-up lỗi thì không hỏi lại (tránh vòng lặp); lỗi khác không hỏi', async () => {
    const ask = vi.fn(() => Promise.resolve(true));
    setStepUpHandler(ask);
    const a = client([{ status: 403, body: stepUpProblem }]);
    await expect(sendWith(a.c, 'POST', STEP_UP_PATH)).rejects.toBeInstanceOf(ApiError);
    const b = client([{ status: 409, body: { ...stepUpProblem, status: 409, code: 'conflict' } }]);
    await expect(sendWith(b.c, 'POST', '/x')).rejects.toBeInstanceOf(ApiError);
    expect(ask).not.toHaveBeenCalled();
  });
});
