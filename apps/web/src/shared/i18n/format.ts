/** Định dạng theo locale. Dùng hàm này thay vì tự nối chuỗi số/ngày/dung lượng. */
export type Locale = 'vi' | 'en';

const TAG: Record<Locale, string> = { vi: 'vi-VN', en: 'en-US' };

export function formatNumber(
  value: number,
  locale: Locale,
  opts?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(TAG[locale], opts).format(value);
}

/** 0.375 → "37,5%" (vi) / "37.5%" (en). */
export function formatPercent(ratio: number, locale: Locale, fractionDigits = 1): string {
  return new Intl.NumberFormat(TAG[locale], {
    style: 'percent',
    maximumFractionDigits: fractionDigits,
  }).format(ratio);
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Dung lượng theo hệ 1024 (đúng cách hệ điều hành và quota tính), nhãn KB/MB/GB quen thuộc với người dùng hosting.
 * 1536 → "1,5 KB" (vi) / "1.5 KB" (en).
 */
export function formatBytes(bytes: number, locale: Locale, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : fractionDigits;
  return `${formatNumber(v, locale, { maximumFractionDigits: digits })} ${UNITS[i] ?? 'B'}`;
}

/** Megabyte (đơn vị trong contracts: disk_mb, ram_mb) → chuỗi dễ đọc. */
export function formatMegabytes(mb: number, locale: Locale): string {
  return formatBytes(mb * 1024 * 1024, locale);
}

export function formatDate(iso: string | Date, locale: Locale, timeZone?: string): string {
  return new Intl.DateTimeFormat(TAG[locale], {
    dateStyle: 'medium',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

export function formatDateTime(iso: string | Date, locale: Locale, timeZone?: string): string {
  return new Intl.DateTimeFormat(TAG[locale], {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** "3 phút trước" / "in 2 days". */
export function formatRelative(iso: string | Date, locale: Locale, now: Date = new Date()): string {
  const diff = (new Date(iso).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(TAG[locale], { numeric: 'auto' });
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86400, 'hour'],
    [604800, 'day'],
    [2629800, 'week'],
    [31557600, 'month'],
  ];
  let unit: Intl.RelativeTimeFormatUnit = 'year';
  let div = 31557600;
  let prev = 1;
  for (const [limit, u] of steps) {
    if (abs < limit) {
      unit = u;
      div = prev;
      break;
    }
    prev = limit;
  }
  return rtf.format(Math.round(diff / div), unit);
}
