import type { paths as AdminPaths } from '@/api/generated/admin/schema';
import type { paths as PortalPaths } from '@/api/generated/portal/schema';
import { db, type DemoDb } from './db';

/** Mọi đường dẫn mock phải có trong OpenAPI (type sinh từ contracts): không mock endpoint ngoài contract. */
export type ApiPath = keyof AdminPaths | keyof PortalPaths;
export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Ctx {
  db: DemoDb;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  /** Người dùng demo đang thao tác (header X-Demo-User, mặc định theo realm). */
  actor: Actor;
  request: Request;
}

export interface Actor {
  uuid: string;
  name: string;
  email: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
  realm: 'admin' | 'portal';
}

type Resolver = (ctx: Ctx) => Reply | Promise<Reply>;

interface Route {
  method: Method;
  path: ApiPath;
  re: RegExp;
  keys: string[];
  fn: Resolver;
}

const routes: Route[] = [];

/** Đăng ký handler cho một operation OpenAPI. `{id}` trong đường dẫn là tham số. */
export function on(method: Method, path: ApiPath, fn: Resolver) {
  const keys: string[] = [];
  const pattern = path.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === '{' || ch === '}' ? ch : `\\${ch}`,
  );
  const re = new RegExp(
    `^${pattern.replace(/\{(\w+)\}/g, (_, k: string) => {
      keys.push(k);
      return '([^/:]+)';
    })}$`,
  );
  routes.push({ method, path, re, keys, fn });
}

/** Danh sách operation đã mock (cho test đối chiếu OpenAPI). */
export function registeredRoutes(): { method: Method; path: ApiPath }[] {
  return routes.map(({ method, path }) => ({ method, path }));
}

export function problem(status: number, code: string, title: string, detail?: string): Reply {
  return {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
    body: {
      type: `https://docs.itso.local/problems/${code.replaceAll('_', '-')}`,
      title,
      status,
      code,
      ...(detail ? { detail } : {}),
    },
  };
}

export const ok = (data: unknown): Reply => ({ status: 200, body: { data } });
export const created = (data: unknown): Reply => ({ status: 201, body: { data } });
export const noContent = (): Reply => ({ status: 204 });

const USERS = () => db().data.users;

function resolveActor(request: Request, realm: 'admin' | 'portal'): Actor {
  const want = request.headers.get('X-Demo-User');
  const users = USERS();
  const u =
    users.find((x) => x.uuid === want && x.realm === realm) ??
    users.find((x) => x.realm === realm && (realm === 'admin' ? x.role === 'SUPER_ADMIN' : true));
  if (!u) throw new Error('dữ liệu demo thiếu user');
  return { uuid: u.uuid, name: u.name, email: u.email, role: u.role, realm };
}

/** Xử lý một request /api/...; trả null nếu không có handler (để MSW cho đi tiếp). */
export async function dispatch(request: Request): Promise<Reply | null> {
  const url = new URL(request.url);
  const method = request.method.toLowerCase() as Method;
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = Object.fromEntries(
      r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? '')]),
    );
    let body: unknown = undefined;
    const binary = /octet-stream/.test(request.headers.get('Content-Type') ?? '');
    if (method !== 'get' && method !== 'delete' && !binary) {
      // Chunk tải lên (octet-stream) để nguyên cho handler đọc bằng arrayBuffer().
      const text = await request.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          return problem(400, 'bad_request', 'JSON không hợp lệ');
        }
      }
    }
    const realm = url.pathname.startsWith('/api/v1/portal/') ? 'portal' : 'admin';
    const store = db();
    store.tick();
    // Như API thật (DataJobs): account đang chuyển server → mọi thao tác ghi dữ liệu của account bị chặn 409.
    const accUuid = (body as { hosting_account_uuid?: unknown } | undefined)?.hosting_account_uuid;
    if (method !== 'get' && typeof accUuid === 'string') {
      const acc = store.data.accounts.find((a) => a.uuid === accUuid);
      if (acc?.lifecycle_state === 'migrating')
        return problem(
          409,
          'invalid_state_transition',
          'Account đang chuyển máy chủ',
          `Account ${acc.username} đang chuyển sang máy chủ mới: tạm thời chỉ xem.`,
        );
    }
    return r.fn({
      db: store,
      params,
      query: url.searchParams,
      body,
      actor: resolveActor(
        request,
        realm === 'portal' || request.headers.get('X-Demo-Realm') === 'portal' ? 'portal' : 'admin',
      ),
      request,
    });
  }
  return null;
}
