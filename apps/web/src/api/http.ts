import type { components } from './generated/admin/schema';

/** RFC 9457 problem+json (schema `Problem` trong contracts/openapi/common.yaml). */
export type Problem = components['schemas']['Problem'];

export class ApiError extends Error {
  constructor(public readonly problem: Problem) {
    super(problem.title);
  }
}

/** Mọi client gọi cùng origin (Vite proxy `/api` ở dev, Nginx ở production). */
export const clientOptions = {
  baseUrl: typeof location === 'undefined' ? '' : location.origin,
  credentials: 'same-origin' as const,
  headers: { Accept: 'application/json' },
  // Gọi fetch toàn cục tại thời điểm request (không giữ tham chiếu lúc tạo client).
  fetch: (req: Request) => globalThis.fetch(req),
};

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Lấy `data` của envelope `{ data: T }` hoặc ném ApiError với Problem từ server. */
export function unwrap<T>(r: FetchResult<{ data: T }>): T {
  if (r.data !== undefined && r.response.ok) return r.data.data;
  const p = r.error as Partial<Problem> | undefined;
  throw new ApiError(
    p && typeof p.title === 'string'
      ? (p as Problem)
      : {
          type: 'about:blank',
          title: r.response.statusText || 'Error',
          status: r.response.status,
          code: 'internal_error',
        },
  );
}
