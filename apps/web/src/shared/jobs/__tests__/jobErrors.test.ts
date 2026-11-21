import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/http';
import { errorText } from '@/shared/api/useAction';
import { createI18n } from '@/shared/i18n';
import { EXPLAINED_JOB_ERRORS, explainJobError, quotaResource } from '../jobErrors';

describe('lỗi job dễ hiểu', () => {
  it('nhận mã có giải thích, bỏ qua mã lạ', () => {
    expect(explainJobError('config_test_failed')).toBe('config_test_failed');
    expect(explainJobError('replay_rejected')).toBeNull();
    expect(explainJobError(null)).toBeNull();
  });

  it.each(['vi', 'en'] as const)('mọi mã có tiêu đề và gợi ý (%s)', (lng) => {
    const i18n = createI18n(lng);
    for (const c of EXPLAINED_JOB_ERRORS) {
      expect(i18n.exists(`common:jobErrors.${c}.title`), c).toBe(true);
      expect(i18n.exists(`common:jobErrors.${c}.hint`), c).toBe(true);
    }
  });
});

describe('quota theo gói', () => {
  const problem = (errors?: Record<string, string[]>) =>
    new ApiError({
      type: 'about:blank',
      title: 'Vượt giới hạn gói',
      status: 422,
      code: 'quota_exceeded',
      detail: 'Đã dùng 3/3 websites theo gói.',
      ...(errors ? { errors } : {}),
    } as never);

  it('lấy tài nguyên từ errors', () => {
    expect(quotaResource({ websites: ['x'] })).toBe('websites');
    expect(quotaResource({ lạ: ['x'] })).toBeNull();
    expect(quotaResource(undefined)).toBeNull();
  });

  it('diễn giải theo gói khi có t; giữ detail khi không có', () => {
    const t = createI18n('vi').getFixedT('vi', 'common');
    expect(errorText(problem({ websites: ['x'] }), t)).toBe(
      'Gói hosting của account đã hết hạn mức website. Đã dùng 3/3 websites theo gói. Nâng gói hoặc gỡ bớt rồi thử lại.',
    );
    expect(errorText(problem(), t)).toContain('hạn mức tài nguyên');
    expect(errorText(problem({ websites: ['x'] }))).toBe('Đã dùng 3/3 websites theo gói.');
  });
});
