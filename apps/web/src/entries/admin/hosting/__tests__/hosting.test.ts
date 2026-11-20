import { describe, expect, it } from 'vitest';
import { dataset } from '@/demo/dataset';
import {
  accountSchema,
  daysLeft,
  migrationStep,
  purgeStage,
  suggestUsername,
  usernameSchema,
} from '../accounts';
import { DEFAULT_LIMITS, diffLimits, limitsSchema, packageSchema } from '../packages';

const issues = (r: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.map(String).join('.'), i.message]));

describe('form gói hosting', () => {
  const valid = { code: 'student', name: 'Sinh viên', description: '', limits: DEFAULT_LIMITS };

  it('chấp nhận giới hạn mặc định và giới hạn của các gói mẫu', () => {
    expect(packageSchema.safeParse(valid).success).toBe(true);
    for (const p of dataset.packages) expect(limitsSchema.safeParse(p.limits).success).toBe(true);
  });

  it('báo lỗi theo khóa i18n: mã gói, số âm, PHP rỗng, giữ dữ liệu < 30 ngày (D-46)', () => {
    const r = packageSchema.safeParse({
      ...valid,
      code: 'Sinh Vien',
      limits: {
        ...DEFAULT_LIMITS,
        disk_mb: 0,
        website_limit: -1,
        cpu_percent: 1.5,
        php_versions: [],
        retention_days_after_terminate: 7,
      },
    });
    expect(issues(r)).toMatchObject({
      code: 'admin:packages.errors.code',
      'limits.disk_mb': 'admin:packages.errors.min|1',
      'limits.website_limit': 'admin:packages.errors.min|0',
      'limits.cpu_percent': 'admin:packages.errors.number',
      'limits.php_versions': 'admin:packages.errors.php',
      'limits.retention_days_after_terminate': 'admin:packages.errors.retention',
    });
  });

  it('ô số để trống (NaN) báo "nhập số nguyên"', () => {
    const r = limitsSchema.safeParse({ ...DEFAULT_LIMITS, ram_mb: Number.NaN });
    expect(issues(r)['ram_mb']).toBe('admin:packages.errors.number');
  });

  it('diffLimits chỉ liệt kê giới hạn đổi giữa hai phiên bản', () => {
    const [v1, v2] = dataset.package_versions.filter(
      (v) => v.package_uuid === dataset.packages[0]?.uuid,
    );
    const d = diffLimits(v1!.limits, v2!.limits);
    expect(d.map((x) => x.key)).toContain('disk_mb');
    expect(d.map((x) => x.key)).not.toContain('ram_mb');
    expect(diffLimits(DEFAULT_LIMITS, DEFAULT_LIMITS)).toEqual([]);
  });
});

describe('wizard tạo tài khoản', () => {
  const ok = {
    owner_user_uuid: 'u',
    package_uuid: 'p',
    server_uuid: 's',
    username: 'phongkt',
    primary_domain: '',
  };

  it('username: 3–16 ký tự, bắt đầu bằng chữ, không dùng tên hệ thống', () => {
    for (const u of ['abc', 'anphat2026', 'a234567890123456']) {
      expect(usernameSchema.safeParse(u).success, u).toBe(true);
    }
    for (const u of ['ab', '1abc', 'An', 'an_phat', 'a2345678901234567']) {
      expect(usernameSchema.safeParse(u).error?.issues[0]?.message, u).toBe(
        'admin:accounts.errors.username',
      );
    }
    expect(usernameSchema.safeParse('root').error?.issues[0]?.message).toBe(
      'admin:accounts.errors.reserved',
    );
  });

  it('mỗi bước bắt buộc chọn; domain không bắt buộc nhưng phải hợp lệ, tự chuyển chữ thường', () => {
    expect(accountSchema.safeParse(ok).success).toBe(true);
    expect(
      issues(accountSchema.safeParse({ ...ok, owner_user_uuid: '', server_uuid: '' })),
    ).toEqual({
      owner_user_uuid: 'admin:accounts.errors.owner',
      server_uuid: 'admin:accounts.errors.server',
    });
    expect(issues(accountSchema.safeParse({ ...ok, primary_domain: 'không hợp lệ' }))).toEqual({
      primary_domain: 'admin:accounts.errors.domain',
    });
    expect(accountSchema.parse({ ...ok, primary_domain: ' KeToan.ITSO.vn ' }).primary_domain).toBe(
      'ketoan.itso.vn',
    );
  });

  it('gợi ý username từ tên chủ sở hữu tiếng Việt', () => {
    expect(suggestUsername('Công ty An Phát')).toBe('anphat');
    expect(suggestUsername('Nhà thuốc Thiện Tâm')).toBe('thientam');
    expect(suggestUsername('Đỗ Đức')).toBe('doduc');
    expect(suggestUsername('2026')).toBe('');
    expect(
      usernameSchema.safeParse(suggestUsername('Phòng Kế toán Tổng hợp miền Bắc')).success,
    ).toBe(true);
  });
});

describe('vòng đời và purge', () => {
  const now = Date.parse('2026-11-20T00:00:00+07:00');
  it('daysLeft làm tròn lên và không âm', () => {
    expect(daysLeft(null, now)).toBeNull();
    expect(daysLeft('2026-12-01T00:00:00+07:00', now)).toBe(11);
    expect(daysLeft('2026-11-20T01:00:00+07:00', now)).toBe(1);
    expect(daysLeft('2026-11-01T00:00:00+07:00', now)).toBe(0);
  });

  it('bước wizard chuyển server theo trạng thái', () => {
    expect(migrationStep(undefined)).toBe('preflight');
    expect(migrationStep({ state: 'preflight' })).toBe('sync');
    expect(migrationStep({ state: 'verifying' })).toBe('verify');
    expect(migrationStep({ state: 'cutover' })).toBe('cutover');
    expect(migrationStep({ state: 'rolled_back' })).toBe('done');
  });

  it('purgeStage theo D-46', () => {
    const by = { uuid: 'a', name: 'A', email: 'a@x' };
    expect(purgeStage(undefined)).toBe('none');
    expect(purgeStage({ backup_verified_at: null, confirmed_by: null, completed_at: null })).toBe(
      'backup',
    );
    expect(purgeStage({ backup_verified_at: 'x', confirmed_by: null, completed_at: null })).toBe(
      'confirm',
    );
    expect(purgeStage({ backup_verified_at: 'x', confirmed_by: by, completed_at: null })).toBe(
      'scheduled',
    );
    expect(purgeStage({ backup_verified_at: 'x', confirmed_by: by, completed_at: 'y' })).toBe(
      'done',
    );
  });
});
