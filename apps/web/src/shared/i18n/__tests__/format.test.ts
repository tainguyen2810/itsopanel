import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDateTime,
  formatMegabytes,
  formatNumber,
  formatPercent,
  formatRelative,
} from '../format';
import { createI18n } from '..';

const nbsp = (s: string) => s.replace(/\u00a0|\u202f/g, ' ');

describe('format theo locale', () => {
  it('số và phần trăm', () => {
    expect(formatNumber(1234567.5, 'vi')).toBe('1.234.567,5');
    expect(formatNumber(1234567.5, 'en')).toBe('1,234,567.5');
    expect(nbsp(formatPercent(0.375, 'vi'))).toMatch(/^37,5 ?%$/);
    expect(formatPercent(0.375, 'en')).toBe('37.5%');
  });

  it('dung lượng hệ 1024', () => {
    expect(formatBytes(0, 'vi')).toBe('0 B');
    expect(formatBytes(1536, 'vi')).toBe('1,5 KB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 ** 3, 'en')).toBe('5 GB');
    expect(formatMegabytes(65536, 'en')).toBe('64 GB');
    expect(formatBytes(-1, 'vi')).toBe('—');
    expect(formatBytes(Number.NaN, 'vi')).toBe('—');
  });

  it('ngày giờ theo múi giờ và tương đối', () => {
    const iso = '2026-11-20T08:15:00+07:00';
    expect(nbsp(formatDateTime(iso, 'en', 'Asia/Ho_Chi_Minh'))).toBe('Nov 20, 2026, 8:15 AM');
    expect(formatDateTime(iso, 'vi', 'Asia/Ho_Chi_Minh')).toContain('2026');
    const now = new Date('2026-11-20T08:15:00+07:00');
    expect(formatRelative('2026-11-20T08:12:00+07:00', 'vi', now)).toBe('3 phút trước');
    expect(formatRelative('2026-11-20T08:12:00+07:00', 'en', now)).toBe('3 minutes ago');
    expect(formatRelative('2026-11-22T08:15:00+07:00', 'en', now)).toBe('in 2 days');
  });
});

describe('i18n', () => {
  it('VI mặc định, đổi sang EN, số nhiều', async () => {
    const i = createI18n('vi');
    expect(i.t('common:actions.save')).toBe('Lưu');
    await i.changeLanguage('en');
    expect(i.t('common:actions.save')).toBe('Save');
    expect(i.t('common:table.selected', { count: 2 })).toBe('2 rows selected');
    expect(document.documentElement.lang).toBe('en');
  });
});
