import { adminApi } from '@/api/admin';
import { ApiError, unwrap } from '@/api/http';
import type { paths } from '@/api/generated/admin/schema';
import { watchJob } from '@/shared/jobs/jobStore';
import type { ListQuery } from '@/shared/page/ListPage';

type Json<R> = R extends { content: { 'application/json': infer B } } ? B : never;
type GetOp<P extends keyof paths> = paths[P] extends { get: infer G } ? G : never;
type Ok<P extends keyof paths> = GetOp<P> extends { responses: { 200: infer R } } ? Json<R> : never;

/** Dữ liệu `data` của GET 200 theo đường dẫn OpenAPI. */
export type Data<P extends keyof paths> = Ok<P> extends { data: infer D } ? D : never;
/** Phần tử của danh sách (CursorPage). */
export type Row<P extends keyof paths> = Data<P> extends (infer T)[] ? T : never;

type Params = {
  path?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
};

/** GET có type theo contract; ném ApiError (Problem) khi lỗi. */
export async function get<P extends keyof paths>(path: P, params: Params = {}): Promise<Data<P>> {
  const r = await adminApi.GET(path as never, { params } as never);
  return unwrap(r as never) as Data<P>;
}

/** Danh sách đầy đủ (limit 200) với q và filter[...] theo tham số contract. */
export function list<P extends keyof paths>(
  path: P,
  q: ListQuery = { filters: {} },
  params: Params = {},
): Promise<Data<P>> {
  const query: Record<string, string | number> = { limit: 200 };
  if (q.q) query.q = q.q;
  for (const [k, v] of Object.entries(q.filters)) query[`filter[${k}]`] = v;
  return get(path, { ...params, query: { ...query, ...params.query } });
}

type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface JobAccepted {
  job: { uuid: string; type: string; state: string };
  resource?: { type: string; uuid: string } | null;
}

/**
 * Gọi thao tác ghi. Gửi `Idempotency-Key` mới cho mỗi lần bấm. Nếu API trả 202 + Job thì mở
 * drawer theo dõi job và trả JobAccepted; trả `data` cho 200/201; `undefined` cho 204.
 */
export async function send<T = unknown>(
  method: Method,
  path: keyof paths,
  opts: { path?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  // Qua client openapi-fetch để middleware (header demo, sau này CSRF) luôn được áp dụng.
  const call = adminApi[method] as unknown as (p: never, o: never) => Promise<unknown>;
  const r = (await call(
    path as never,
    {
      params: { path: opts.path ?? {} },
      ...(opts.body === undefined ? {} : { body: opts.body }),
      headers: { 'Idempotency-Key': crypto.randomUUID(), ...opts.headers },
      parseAs: 'text',
    } as never,
  )) as { data?: string; error?: string; response: Response };
  const res = r.response;
  const text = r.data ?? r.error ?? '';
  if (res.status === 204) return undefined as T;
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    body = null;
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

/** GET trả văn bản (vd. text/csv xuất audit log) qua client openapi-fetch. */
export async function getText<P extends keyof paths>(
  path: P,
  query: Record<string, string | undefined> = {},
): Promise<string> {
  const r = (await adminApi.GET(
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
