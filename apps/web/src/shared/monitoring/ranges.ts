/** Khoảng thời gian biểu đồ (D-101): ≤ 24 giờ đọc mẫu 1 phút, dài hơn đọc rollup 1 giờ. */
export type Range = '1h' | '24h' | '7d' | '30d' | '90d';
export const RANGES: Range[] = ['1h', '24h', '7d', '30d', '90d'];

/** Nhãn trục X: giờ:phút cho khoảng ngắn, ngày cho khoảng dài. */
export function timeLabel(ts: string, range: Range, date: (iso: string) => string) {
  return range === '1h' || range === '24h' ? ts.slice(11, 16) : date(ts);
}
