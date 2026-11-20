import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '@/shared/i18n';
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMegabytes,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTime,
} from '@/shared/i18n/format';

/** Định dạng theo ngôn ngữ đang chọn (số, %, dung lượng, ngày giờ, thời gian tương đối). */
export function useFmt() {
  const { i18n } = useTranslation();
  const l = currentLocale(i18n);
  return useMemo(
    () => ({
      locale: l,
      num: (n: number, digits = 0) =>
        formatNumber(n, l, { maximumFractionDigits: digits, minimumFractionDigits: 0 }),
      /** pct(37.5) → "37,5%" (đầu vào là phần trăm 0–100). */
      pct: (p: number, digits = 0) => formatPercent(p / 100, l, digits),
      bytes: (b: number) => formatBytes(b, l),
      mb: (mb: number) => formatMegabytes(mb, l),
      date: (iso: string) => formatDate(iso, l),
      dateTime: (iso: string) => formatDateTime(iso, l),
      time: (iso: string) => formatTime(iso, l),
      rel: (iso: string) => formatRelative(iso, l),
      /** duration(3600) → "1 giờ". */
      duration: (sec: number) => formatDuration(sec, l),
      opt: (iso: string | null | undefined, empty = '—') => (iso ? formatDateTime(iso, l) : empty),
    }),
    [l],
  );
}
