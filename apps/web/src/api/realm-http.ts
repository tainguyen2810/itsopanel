import type { Middleware } from 'openapi-fetch';

/**
 * Lớp HTTP cho API thật (build thường, không MSW) theo D-58:
 * - Mọi request mang `X-ITSO-Realm` (endpoint `/auth/*` dùng chung xác định realm theo header).
 * - Request ghi gửi `X-XSRF-TOKEN` = cookie `XSRF-TOKEN-{REALM}` (double-submit); chưa có cookie thì gọi
 *   `GET /api/v1/auth/csrf` trước. Gặp 419 (token hết hạn/xoay vòng) thì lấy token mới và gửi lại một lần.
 * - 401 ngoài `/auth/*` phát sự kiện `itso:unauthenticated` để phiên chuyển về trang đăng nhập đúng realm.
 */
export type ApiRealm = 'admin' | 'portal';

export const UNAUTHENTICATED_EVENT = 'itso:unauthenticated';

const xsrfName = (realm: ApiRealm) => `XSRF-TOKEN-${realm.toUpperCase()}`;

export function readXsrf(realm: ApiRealm): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${xsrfName(realm)}=`;
  for (const part of document.cookie.split(';')) {
    const c = part.trim();
    if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length));
  }
  return null;
}

let pending: Promise<void> | null = null;

/** Lấy cookie CSRF của realm (gọi chung một request khi nhiều thao tác cùng lúc). */
export function ensureCsrf(realm: ApiRealm, force = false): Promise<void> {
  if (!force && readXsrf(realm)) return Promise.resolve();
  pending ??= globalThis
    .fetch('/api/v1/auth/csrf', {
      credentials: 'same-origin',
      headers: { 'X-ITSO-Realm': realm, Accept: 'application/json' },
    })
    .then(() => undefined)
    .finally(() => {
      pending = null;
    });
  return pending;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function realmMiddleware(realm: ApiRealm): Middleware {
  const retries = new WeakMap<Request, Request>();
  return {
    async onRequest({ request }) {
      request.headers.set('X-ITSO-Realm', realm);
      if (!SAFE.has(request.method)) {
        await ensureCsrf(realm);
        const token = readXsrf(realm);
        if (token) request.headers.set('X-XSRF-TOKEN', token);
        retries.set(request, request.clone());
      }
      return request;
    },
    async onResponse({ request, response }) {
      const path = new URL(request.url, 'http://x').pathname;
      if (response.status === 419) {
        const again = retries.get(request);
        retries.delete(request);
        if (again) {
          await ensureCsrf(realm, true);
          const token = readXsrf(realm);
          if (token) again.headers.set('X-XSRF-TOKEN', token);
          return globalThis.fetch(again);
        }
      }
      if (response.status === 401 && !path.startsWith('/api/v1/auth/')) {
        globalThis.dispatchEvent?.(new CustomEvent(UNAUTHENTICATED_EVENT, { detail: { realm } }));
      }
      return response;
    },
  };
}
