/**
 * Biểu thức cron 5 trường dạng số (CronExpr trong contract): phút giờ ngày tháng thứ.
 * Hỗ trợ `*`, `*\/n`, `a`, `a-b`, `a-b/n` và danh sách cách nhau bằng dấu phẩy. Thứ: 0–7 (0 và 7 là CN).
 */

const FIELDS = [
  { key: 'minute', min: 0, max: 59 },
  { key: 'hour', min: 0, max: 23 },
  { key: 'day', min: 1, max: 31 },
  { key: 'month', min: 1, max: 12 },
  { key: 'weekday', min: 0, max: 7 },
] as const;
export type CronField = (typeof FIELDS)[number]['key'];

export type CronParse =
  | { ok: true; sets: Set<number>[] }
  | { ok: false; error: 'fields' | 'syntax' | 'range'; field?: CronField };

function expand(part: string, min: number, max: number): Set<number> | 'syntax' | 'range' {
  const out = new Set<number>();
  for (const item of part.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!m) return 'syntax';
    const step = m[4] === undefined ? 1 : Number(m[4]);
    if (step < 1) return 'range';
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      lo = Number(m[2]);
      hi = m[3] === undefined ? (m[4] === undefined ? lo : max) : Number(m[3]);
    }
    if (lo < min || hi > max || lo > hi) return 'range';
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronParse {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: 'fields' };
  const sets: Set<number>[] = [];
  for (const [i, f] of FIELDS.entries()) {
    const r = expand(parts[i] as string, f.min, f.max);
    if (typeof r === 'string') return { ok: false, error: r, field: f.key };
    sets.push(r);
  }
  const wd = sets[4] as Set<number>;
  if (wd.has(7)) wd.add(0);
  return { ok: true, sets };
}

/** Các lần chạy kế tiếp (giờ địa phương của trình duyệt), tối đa tìm trong 366 ngày. */
export function nextRuns(expr: string, from: Date, count = 5): Date[] {
  const p = parseCron(expr);
  if (!p.ok) return [];
  const [mi, ho, da, mo, wd] = p.sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  const parts = expr.trim().split(/\s+/);
  const dayAny = parts[2] === '*';
  const wdAny = parts[4] === '*';
  const out: Date[] = [];
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + 366 * 86_400_000;
  while (out.length < count && t.getTime() <= limit) {
    if (!mo.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    // Cron chuẩn: nếu cả ngày và thứ đều bị giới hạn thì khớp MỘT trong hai.
    const dOk = da.has(t.getDate());
    const wOk = wd.has(t.getDay());
    const dayMatch = dayAny && wdAny ? true : dayAny ? wOk : wdAny ? dOk : dOk || wOk;
    if (!dayMatch) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!ho.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (mi.has(t.getMinutes())) out.push(new Date(t.getTime()));
    t.setMinutes(t.getMinutes() + 1);
  }
  return out;
}

/** Khoảng cách nhỏ nhất (phút) giữa các lần chạy, để so với `cron_min_interval_min` của gói. */
export function minInterval(expr: string, from = new Date('2026-01-05T00:00:00')): number | null {
  const runs = nextRuns(expr, from, 60);
  if (runs.length < 2) return null;
  let min = Infinity;
  for (let i = 1; i < runs.length; i++) {
    min = Math.min(min, ((runs[i] as Date).getTime() - (runs[i - 1] as Date).getTime()) / 60_000);
  }
  return min;
}

export type CronText =
  | { key: 'everyMinute' }
  | { key: 'everyNMinutes'; n: number }
  | { key: 'hourly'; minute: number }
  | { key: 'everyNHours'; n: number; minute: number }
  | { key: 'daily'; time: string }
  | { key: 'weekly'; time: string; weekday: number }
  | { key: 'monthly'; time: string; day: number }
  | { key: 'custom' };

const pad = (n: number) => String(n).padStart(2, '0');

/** Mô tả các mẫu phổ biến (khóa i18n + tham số); mẫu khác trả `custom`. */
export function describeCron(expr: string): CronText {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5 || !parseCron(expr).ok) return { key: 'custom' };
  const [m, h, d, mo, w] = parts as [string, string, string, string, string];
  const num = (x: string) => (/^\d+$/.test(x) ? Number(x) : null);
  const step = (x: string) => /^\*\/(\d+)$/.exec(x)?.[1];
  if (d !== '*' || mo !== '*') {
    if (mo === '*' && w === '*' && num(d) !== null && num(m) !== null && num(h) !== null) {
      return {
        key: 'monthly',
        time: `${pad(num(h) as number)}:${pad(num(m) as number)}`,
        day: num(d) as number,
      };
    }
    return { key: 'custom' };
  }
  if (m === '*' && h === '*' && w === '*') return { key: 'everyMinute' };
  if (step(m) && h === '*' && w === '*') return { key: 'everyNMinutes', n: Number(step(m)) };
  if (num(m) !== null && h === '*' && w === '*') return { key: 'hourly', minute: num(m) as number };
  if (num(m) !== null && step(h) && w === '*') {
    return { key: 'everyNHours', n: Number(step(h)), minute: num(m) as number };
  }
  if (num(m) !== null && num(h) !== null) {
    const time = `${pad(num(h) as number)}:${pad(num(m) as number)}`;
    if (w === '*') return { key: 'daily', time };
    if (num(w) !== null) return { key: 'weekly', time, weekday: (num(w) as number) % 7 };
  }
  return { key: 'custom' };
}

export const CRON_PRESETS = [
  '*/5 * * * *',
  '*/15 * * * *',
  '0 * * * *',
  '0 2 * * *',
  '30 3 * * 0',
  '0 4 1 * *',
] as const;
