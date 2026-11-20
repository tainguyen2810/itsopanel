import { problem, type Ctx, type Reply } from './router';

type Row = Record<string, unknown>;

/** Lấy giá trị theo đường dẫn "a.b" (để lọc theo filter[server] → server.uuid…). */
export function get(row: Row, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Row)[k] : undefined), row);
}

export interface ListOptions {
  /** Trường dùng cho tìm kiếm `q`. */
  search?: string[];
  /** filter[x] → đường dẫn trường trong bản ghi. */
  filters?: Record<string, string>;
  /** Sắp xếp mặc định, cú pháp như tham số sort (`-created_at`). */
  sort?: string;
}

/**
 * Trả về CursorPage theo tham số chung của contracts: q, sort, filter[...], limit (1..200, mặc định 50),
 * cursor (vị trí bắt đầu, mã hóa base64url).
 */
export function page<T>(ctx: Ctx, items: T[], opts: ListOptions = {}): Reply {
  const q = ctx.query;
  let rows = [...items] as Row[];

  const term = q.get('q')?.trim().toLowerCase();
  if (term && opts.search) {
    rows = rows.filter((r) =>
      opts.search?.some((f) =>
        String(get(r, f) ?? '')
          .toLowerCase()
          .includes(term),
      ),
    );
  }
  for (const [key, field] of Object.entries(opts.filters ?? {})) {
    const v = q.get(`filter[${key}]`);
    if (v !== null && v !== '') rows = rows.filter((r) => String(get(r, field)) === v);
  }

  const sort = q.get('sort') ?? opts.sort;
  if (sort) {
    if (!/^-?[a-z_]+(,-?[a-z_]+)*$/.test(sort))
      return problem(422, 'validation_failed', 'Tham số sort không hợp lệ');
    const keys = sort
      .split(',')
      .map((s) => (s.startsWith('-') ? { k: s.slice(1), dir: -1 } : { k: s, dir: 1 }));
    rows.sort((a, b) => {
      for (const { k, dir } of keys) {
        const x = get(a, k);
        const y = get(b, k);
        if (x === y) continue;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (
          (typeof x === 'number' && typeof y === 'number'
            ? x - y
            : String(x).localeCompare(String(y))) * dir
        );
      }
      return 0;
    });
  }

  const limitRaw = q.get('limit');
  const limit = limitRaw === null ? 50 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return problem(422, 'validation_failed', 'limit phải từ 1 đến 200');
  }
  const cursor = q.get('cursor');
  const start = cursor ? Number(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) || 0 : 0;
  const slice = rows.slice(start, start + limit);
  const next = start + limit < rows.length ? btoa(String(start + limit)).replace(/=+$/, '') : null;
  return { status: 200, body: { data: slice, meta: { next_cursor: next, limit } } };
}

/** Tìm bản ghi theo uuid hoặc trả 404 problem. */
export function findOr404<T extends { uuid: string }>(
  items: T[],
  id: string | undefined,
  what: string,
): T | Reply {
  const x = items.find((i) => i.uuid === id);
  return x ?? problem(404, 'not_found', `Không tìm thấy ${what}`);
}

export function isReply(x: unknown): x is Reply {
  return (
    typeof x === 'object' &&
    x !== null &&
    'status' in x &&
    typeof (x as Reply).status === 'number' &&
    !('uuid' in x)
  );
}
