/** Quy tắc 3-2-1-1-0: 3 bản sao, 2 loại lưu trữ, 1 bản offsite, 1 bản bất biến/offline, 0 lỗi khi kiểm chứng. */
export interface DestLike {
  type: 'local' | 'sftp' | 's3' | 'rest';
  append_only: boolean;
  immutable_days: number | null;
  last_check_ok: boolean | null;
}
export interface SnapshotLike {
  hosting_account: { uuid: string } | null;
  taken_at: string;
  verified_at: string | null;
  tags: string[];
}
export interface PolicyLike {
  enabled: boolean;
  last_status: string | null;
}

export type RuleKey = 'copies' | 'media' | 'offsite' | 'immutable' | 'errors';
export interface RuleResult {
  key: RuleKey;
  ok: boolean;
  /** Số liệu cho câu mô tả (i18n). */
  value: number;
}

/** Snapshot mới nhất được kiểm chứng trong vòng này mới tính là "0 lỗi". */
export const VERIFY_WINDOW_DAYS = 7;
const OFFSITE = new Set(['sftp', 's3', 'rest']);

/** Snapshot mới nhất của mỗi account còn hoạt động (bỏ bản "final" giữ lại khi purge). */
export function latestPerAccount<T extends SnapshotLike>(snaps: T[]): T[] {
  const by = new Map<string, T>();
  for (const s of snaps) {
    if (!s.hosting_account || s.tags.includes('final')) continue;
    const cur = by.get(s.hosting_account.uuid);
    if (!cur || s.taken_at > cur.taken_at) by.set(s.hosting_account.uuid, s);
  }
  return [...by.values()];
}

export type VerifyState = 'verified' | 'stale' | 'never';
export function verifyState(s: SnapshotLike, now = Date.now()): VerifyState {
  if (!s.verified_at) return 'never';
  return now - Date.parse(s.verified_at) <= VERIFY_WINDOW_DAYS * 86_400_000 ? 'verified' : 'stale';
}

export function rule32110(
  dests: DestLike[],
  snaps: SnapshotLike[],
  policies: PolicyLike[],
  now = Date.now(),
): RuleResult[] {
  const healthy = dests.filter((d) => d.last_check_ok !== false);
  const types = new Set(healthy.map((d) => (d.type === 'rest' ? 'sftp' : d.type)));
  const offsite = healthy.filter((d) => OFFSITE.has(d.type)).length;
  const immutable = healthy.filter((d) => d.append_only || (d.immutable_days ?? 0) > 0).length;
  const errors =
    dests.filter((d) => d.last_check_ok === false).length +
    policies.filter((p) => p.enabled && p.last_status === 'failed').length +
    latestPerAccount(snaps).filter((s) => verifyState(s, now) !== 'verified').length;
  // Bản gốc trên máy chủ + mỗi đích khỏe là một bản sao.
  const copies = healthy.length + 1;
  return [
    { key: 'copies', ok: copies >= 3, value: copies },
    { key: 'media', ok: types.size >= 2, value: types.size },
    { key: 'offsite', ok: offsite >= 1, value: offsite },
    { key: 'immutable', ok: immutable >= 1, value: immutable },
    { key: 'errors', ok: errors === 0, value: errors },
  ];
}
