import { ApiError, unwrap } from '@/api/http';
import { requestStepUp, STEP_UP_PATH } from '@/shared/auth/stepUp';
import { watchJob } from '@/shared/jobs/jobStore';
import type { ListQuery } from '@/shared/page/ListPage';

/**
 * Lõi gọi API dùng chung cho mọi realm: nhận client openapi-fetch và đường dẫn đầy đủ.
 * Type theo contract nằm ở lớp bọc (`entries/admin/api.ts`, `shared/api/realm.ts`).
 */
type Fn = (path: never, init: never) => Promise<unknown>;
export interface AnyClient {
  GET: Fn;
  POST: Fn;
  PUT: Fn;
  PATCH: Fn;
  DELETE: Fn;
}

export type Params = {
  path?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
};
export type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface JobAccepted {
  job: { uuid: string; type: string; state: string };
  resource?: { type: string; uuid: string } | null;
}

export async function getWith(client: AnyClient, path: string, params: Params = {}) {
  const r = await client.GET(path as never, { params } as never);
  return unwrap(r as never) as unknown;
}

/** Tham số danh sách: limit 200, q và filter[...] theo contract. */
export function listQuery(q: ListQuery = { filters: {} }, params: Params = {}): Params {
  const query: Record<string, string | number> = { limit: 200 };
  if (q.q) query.q = q.q;
  for (const [k, v] of Object.entries(q.filters)) query[`filter[${k}]`] = v;
  return { ...params, query: { ...query, ...params.query } };
}

/**
 * Gọi thao tác ghi. Gửi `Idempotency-Key` mới cho mỗi lần bấm. Nếu API trả 202 + Job thì mở
 * drawer theo dõi job và trả JobAccepted; trả `data` cho 200/201; `undefined` cho 204.
 */
export async function sendWith<T>(
  client: AnyClient,
  method: Method,
  path: string,
  opts: { path?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  try {
    return await sendOnce<T>(client, method, path, opts);
  } catch (e) {
    // Thao tác nhạy cảm cần step-up MFA: hỏi mã TOTP rồi gửi lại đúng một lần (API chưa xử lý request bị từ chối).
    if (
      e instanceof ApiError &&
      e.problem.code === 'mfa_step_up_required' &&
      path !== STEP_UP_PATH &&
      (await requestStepUp())
    ) {
      return sendOnce<T>(client, method, path, opts);
    }
    throw e;
  }
}

async function sendOnce<T>(
  client: AnyClient,
  method: Method,
  path: string,
  opts: { path?: Record<string, string>; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  // Qua client openapi-fetch để middleware (header demo, sau này CSRF) luôn được áp dụng.
  const r = (await client[method](
    path as never,
    {
      params: { path: opts.path ?? {} },
      ...(opts.body === undefined ? {} : { body: opts.body }),
      headers: { 'Idempotency-Key': crypto.randomUUID(), ...opts.headers },
      parseAs: 'text',
    } as never,
  )) as { data?: string; error?: string | Record<string, unknown>; response: Response };
  const res = r.response;
  if (res.status === 204) return undefined as T;
  // openapi-fetch bỏ qua parseAs với phản hồi lỗi: `error` có thể đã là object (JSON) hoặc chuỗi.
  const raw = r.data ?? r.error ?? '';
  let body: Record<string, unknown> | null = null;
  if (typeof raw === 'object') {
    body = raw;
  } else {
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    throw new ApiError(
      body && typeof body.title === 'string'
        ? (body as unknown as ApiError['problem'])
        : {
            type: 'about:blank',
            title: res.statusText,
            status: res.status,
            code: 'internal_error',
          },
    );
  }
  if (res.status === 202 && body && 'job' in body) {
    const accepted = body as unknown as JobAccepted;
    watchJob(accepted.job.uuid);
    return accepted as T;
  }
  return (body?.data ?? body) as T;
}

/** GET trả văn bản (vd. text/csv) qua client openapi-fetch. */
export async function getTextWith(
  client: AnyClient,
  path: string,
  query: Record<string, string | undefined> = {},
): Promise<string> {
  const r = (await client.GET(
    path as never,
    {
      params: { query: Object.fromEntries(Object.entries(query).filter(([, v]) => v)) },
      parseAs: 'text',
    } as never,
  )) as { data?: string; error?: unknown; response: Response };
  if (!r.response.ok) {
    throw new ApiError({
      type: 'about:blank',
      title: r.response.statusText || 'Error',
      status: r.response.status,
      code: 'internal_error',
    });
  }
  return r.data ?? '';
}
