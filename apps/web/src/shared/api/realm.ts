import { portalApi } from '@/api/portal';
import type { paths } from '@/api/generated/portal/schema';
import type { ListQuery } from '@/shared/page/ListPage';
import type { Realm } from '@/shared/session/personas';
import {
  getWith,
  listQuery,
  sendWith,
  type AnyClient,
  type JobAccepted,
  type Method,
  type Params,
} from './core';

export type { JobAccepted };

/**
 * API theo realm cho trang dùng chung Admin/Portal (website, database, file, cron…).
 * Đường dẫn viết KHÔNG kèm tiền tố (`/websites/{id}`) và type theo contract Portal: trang dùng
 * chung chỉ gọi được endpoint có ở cả hai realm (schema chung trong common.yaml). Mỗi entry gọi
 * `configureRealmApi` một lần với client của mình; mặc định là Portal.
 */
type Full = keyof paths;
type Strip<T> = T extends `/api/v1/portal${infer R}` ? R : never;
export type RealmPath = Strip<Full>;
type FullOf<P extends RealmPath> = `/api/v1/portal${P}` extends Full ? `/api/v1/portal${P}` : never;

type Json<R> = R extends { content: { 'application/json': infer B } } ? B : never;
type GetOp<P extends Full> = paths[P] extends { get: infer G } ? G : never;
type Ok<P extends Full> = GetOp<P> extends { responses: { 200: infer R } } ? Json<R> : never;

/** `data` của GET 200 theo đường dẫn (không tiền tố). */
export type Data<P extends RealmPath> = Ok<FullOf<P>> extends { data: infer D } ? D : never;
/** Phần tử của danh sách (CursorPage). */
export type Row<P extends RealmPath> = Data<P> extends (infer T)[] ? T : never;

let realm: Realm = 'portal';
let client: AnyClient = portalApi as unknown as AnyClient;

export function configureRealmApi(r: Realm, c: unknown) {
  realm = r;
  client = c as AnyClient;
}
export const apiRealm = () => realm;
const full = (p: string) => `/api/v1/${realm}${p}`;

export async function get<P extends RealmPath>(path: P, params: Params = {}): Promise<Data<P>> {
  return (await getWith(client, full(path), params)) as Data<P>;
}

export function list<P extends RealmPath>(
  path: P,
  q: ListQuery = { filters: {} },
  params: Params = {},
): Promise<Data<P>> {
  return get(path, listQuery(q, params));
}

export function send<T = unknown>(
  method: Method,
  path: RealmPath,
  opts: { path?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  return sendWith<T>(client, method, full(path), opts);
}

/** Endpoint chung của phiên đăng nhập (`/api/v1/auth/...`): đi qua client của realm hiện tại. */
export type AuthPath = Extract<Full, `/api/v1/auth${string}`>;
type AuthData<P extends AuthPath> = Ok<P> extends { data: infer D } ? D : never;

export async function getAuth<P extends AuthPath>(path: P): Promise<AuthData<P>> {
  return (await getWith(client, path)) as AuthData<P>;
}
export function sendAuth<T = unknown>(
  method: Method,
  path: AuthPath,
  opts: { path?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  return sendWith<T>(client, method, path, opts);
}
