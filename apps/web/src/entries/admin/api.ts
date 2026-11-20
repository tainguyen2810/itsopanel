import { adminApi } from '@/api/admin';
import type { paths } from '@/api/generated/admin/schema';
import {
  getTextWith,
  getWith,
  listQuery,
  sendWith,
  type AnyClient,
  type Method,
  type Params,
} from '@/shared/api/core';
import type { ListQuery } from '@/shared/page/ListPage';

export type { JobAccepted } from '@/shared/api/core';
const client = adminApi as unknown as AnyClient;

type Json<R> = R extends { content: { 'application/json': infer B } } ? B : never;
type GetOp<P extends keyof paths> = paths[P] extends { get: infer G } ? G : never;
type Ok<P extends keyof paths> = GetOp<P> extends { responses: { 200: infer R } } ? Json<R> : never;

/** Dữ liệu `data` của GET 200 theo đường dẫn OpenAPI. */
export type Data<P extends keyof paths> = Ok<P> extends { data: infer D } ? D : never;
/** Phần tử của danh sách (CursorPage). */
export type Row<P extends keyof paths> = Data<P> extends (infer T)[] ? T : never;

/** GET có type theo contract; ném ApiError (Problem) khi lỗi. */
export async function get<P extends keyof paths>(path: P, params: Params = {}): Promise<Data<P>> {
  return (await getWith(client, path, params)) as Data<P>;
}

/** Danh sách đầy đủ (limit 200) với q và filter[...] theo tham số contract. */
export function list<P extends keyof paths>(
  path: P,
  q: ListQuery = { filters: {} },
  params: Params = {},
): Promise<Data<P>> {
  return get(path, listQuery(q, params));
}

/** Thao tác ghi (xem `sendWith`: 202 + Job mở drawer theo dõi job). */
export function send<T = unknown>(
  method: Method,
  path: keyof paths,
  opts: { path?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  return sendWith<T>(client, method, path, opts);
}

/** GET trả văn bản (vd. text/csv xuất audit log). */
export function getText<P extends keyof paths>(
  path: P,
  query: Record<string, string | undefined> = {},
): Promise<string> {
  return getTextWith(client, path, query);
}
