import { describe, expect, it } from 'vitest';
import { destBody, destSchema, normalizeItems, policySchema, restoreItem } from '../forms';
import { latestPerAccount, rule32110, verifyState, type DestLike } from '../rules';

const now = Date.parse('2026-11-20T00:00:00+07:00');
const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const snap = (acc: string, takenAgo: number, verifiedAgo: number | null, tags: string[] = []) => ({
  hosting_account: { uuid: acc },
  taken_at: iso(now - takenAgo * day),
  verified_at: verifiedAgo === null ? null : iso(now - verifiedAgo * day),
  tags,
});
const dest = (type: DestLike['type'], extra: Partial<DestLike> = {}): DestLike => ({
  type,
  append_only: false,
  immutable_days: null,
  last_check_ok: true,
  ...extra,
});

describe('Quy tắc 3-2-1-1-0', () => {
  const ok = (r: ReturnType<typeof rule32110>) => Object.fromEntries(r.map((x) => [x.key, x.ok]));

  it('đủ điều kiện: local + S3 Object Lock, mọi snapshot mới nhất đã kiểm chứng', () => {
    const r = rule32110(
      [dest('local'), dest('s3', { immutable_days: 30 })],
      [snap('a', 1, 1), snap('b', 1, 2)],
      [{ enabled: true, last_status: 'success' }],
      now,
    );
    expect(ok(r)).toEqual({
      copies: true,
      media: true,
      offsite: true,
      immutable: true,
      errors: true,
    });
  });
  it('chỉ một đích local: thiếu bản sao, loại lưu trữ, offsite và bất biến', () => {
    const r = rule32110([dest('local')], [snap('a', 1, 1)], [], now);
    expect(ok(r)).toEqual({
      copies: false,
      media: false,
      offsite: false,
      immutable: false,
      errors: true,
    });
  });
  it('đích lỗi không được tính; lỗi kiểm chứng/chính sách cộng vào "0 lỗi"', () => {
    const r = rule32110(
      [dest('local'), dest('sftp', { last_check_ok: false, append_only: true })],
      [snap('a', 1, 10), snap('b', 1, null)],
      [
        { enabled: true, last_status: 'failed' },
        { enabled: false, last_status: 'failed' },
      ],
      now,
    );
    const errors = r.find((x) => x.key === 'errors');
    expect(errors).toEqual({ key: 'errors', ok: false, value: 4 });
    expect(ok(r).immutable).toBe(false);
  });
  it('snapshot mới nhất mỗi account, bỏ bản final', () => {
    const l = latestPerAccount([
      snap('a', 3, 3),
      snap('a', 1, null),
      snap('z', 1, null, ['final']),
    ]);
    expect(l).toHaveLength(1);
    expect(verifyState(l[0]!, now)).toBe('never');
    expect(verifyState(snap('a', 1, 7), now)).toBe('verified');
    expect(verifyState(snap('a', 1, 8), now)).toBe('stale');
  });
});

describe('Chọn mục khôi phục', () => {
  it('đường dẫn trên cây → mục restore', () => {
    expect(restoreItem('sites/anphat.vn/public')).toBe('files:sites/anphat.vn/public');
    expect(restoreItem('databases/anphat_web.sql.zst')).toBe('database:anphat_web');
    expect(restoreItem('config/nginx/anphat.vn.conf')).toBe('config');
  });
  it('bỏ mục con khi đã chọn thư mục cha, gộp config', () => {
    expect(
      normalizeItems([
        'sites/anphat.vn',
        'sites/anphat.vn/public/index.php',
        'sites/anphat.vn-old',
        'config/a',
        'config/b',
        'databases/anphat_shop.sql.zst',
      ]),
    ).toEqual([
      'config',
      'database:anphat_shop',
      'files:sites/anphat.vn',
      'files:sites/anphat.vn-old',
    ]);
  });
});

describe('Form đích và chính sách sao lưu', () => {
  const base = {
    name: 'S3',
    type: 's3' as const,
    path: '',
    host: '',
    endpoint: 'https://s3.example.vn',
    bucket: 'itso',
    region: '',
    url: '',
    password: '',
    access_key: 'AK',
    secret_key: 'SK',
    append_only: false,
    immutable: true,
    immutable_days: 30,
  };
  it('S3: endpoint phải https, Object Lock cần số ngày; body chỉ gửi trường của loại', () => {
    expect(destSchema.safeParse(base).success).toBe(true);
    expect(destSchema.safeParse({ ...base, endpoint: 'http://x' }).success).toBe(false);
    expect(destSchema.safeParse({ ...base, immutable_days: 0 }).success).toBe(false);
    expect(destBody({ ...base, path: '/ignored' })).toEqual({
      name: 'S3',
      type: 's3',
      config: { endpoint: 'https://s3.example.vn', bucket: 'itso' },
      append_only: false,
      immutable_days: 30,
      credentials: { access_key: 'AK', secret_key: 'SK' },
    });
  });
  it('local: đường dẫn tuyệt đối; sửa không nhập lại bí mật thì không gửi credentials', () => {
    const local = {
      ...base,
      type: 'local' as const,
      path: 'backup',
      access_key: '',
      secret_key: '',
    };
    expect(destSchema.safeParse(local).success).toBe(false);
    expect(destBody({ ...local, path: '/srv/backup' })).not.toHaveProperty('credentials');
  });
  it('chính sách: cron hợp lệ, có đích, giữ ít nhất một bản', () => {
    const p = {
      name: 'Hằng ngày',
      scope_type: 'all_accounts' as const,
      scope_uuid: '',
      schedule: '0 2 * * *',
      destination_uuids: ['d'],
      daily: 7,
      weekly: 4,
      monthly: 3,
      enabled: true,
    };
    expect(policySchema.safeParse(p).success).toBe(true);
    expect(policySchema.safeParse({ ...p, schedule: '61 * * * *' }).success).toBe(false);
    expect(policySchema.safeParse({ ...p, destination_uuids: [] }).success).toBe(false);
    expect(policySchema.safeParse({ ...p, daily: 0, weekly: 0, monthly: 0 }).success).toBe(false);
    expect(policySchema.safeParse({ ...p, scope_type: 'server' }).success).toBe(false);
  });
});
