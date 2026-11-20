import type { DemoDb } from './db';
import type { Actor } from './router';

interface ScopeRow {
  scope_type: string;
  uuid: string;
  name: string;
}

/**
 * Phạm vi đã giao cho một ADMIN. Dữ liệu mẫu: Trần Minh có `scopes`, ADMIN khác chưa được giao gì;
 * PUT /users/{id}/scopes ghi đè vào `scopes@<uuid>`.
 */
export function scopeRows(db: DemoDb, uuid: string): ScopeRow[] {
  const saved = db.data[`scopes@${uuid}`] as ScopeRow[] | undefined;
  if (saved) return saved;
  const minh = db.data.users.find((u) => u.role === 'ADMIN');
  return uuid === minh?.uuid ? (db.data.scopes as ScopeRow[]) : [];
}

/** Phạm vi của người đang thao tác (chỉ ADMIN có phạm vi; SUPER_ADMIN thấy hết, USER theo sở hữu). */
export function scopesOf(db: DemoDb, actor: Actor): ScopeRow[] {
  return actor.role === 'ADMIN' ? scopeRows(db, actor.uuid) : [];
}

/**
 * Bộ lọc theo vai trò: SUPER_ADMIN thấy hết; ADMIN chỉ thấy server được giao, account trên các server đó
 * hoặc account được giao riêng; USER chỉ thấy account mình sở hữu.
 */
export function visibility(db: DemoDb, actor: Actor) {
  const accounts = db.data.accounts;
  if (actor.role === 'SUPER_ADMIN') {
    return { all: true, servers: null, accounts: null } as const;
  }
  if (actor.role === 'USER') {
    const own = new Set(accounts.filter((a) => a.owner.uuid === actor.uuid).map((a) => a.uuid));
    return { all: false, servers: new Set<string>(), accounts: own } as const;
  }
  const sc = scopesOf(db, actor);
  const servers = new Set(sc.filter((s) => s.scope_type === 'server').map((s) => s.uuid));
  const acc = new Set(sc.filter((s) => s.scope_type === 'hosting_account').map((s) => s.uuid));
  for (const a of accounts) if (servers.has(a.server.uuid)) acc.add(a.uuid);
  for (const a of accounts) if (acc.has(a.uuid)) servers.add(a.server.uuid);
  return { all: false, servers, accounts: acc } as const;
}

type V = ReturnType<typeof visibility>;

export function canSeeServer(v: V, uuid: string) {
  return v.all || v.servers.has(uuid);
}
export function canSeeAccount(v: V, uuid: string | undefined | null) {
  return v.all || (uuid !== undefined && uuid !== null && v.accounts.has(uuid));
}

/** Lọc danh sách có trường hosting_account (hoặc chính là account). */
export function byAccount<T>(v: V, rows: T[], pick: (r: T) => string | null | undefined): T[] {
  return v.all ? rows : rows.filter((r) => canSeeAccount(v, pick(r)));
}
