import { cn } from '@/shared/lib/utils';

type GaugeTone = 'primary' | 'success' | 'warning' | 'danger' | 'accent' | 'info';

interface Props {
  /** 0–100. */
  value: number;
  label: string;
  /** Dòng phụ, vd "28,1 / 64 GB". */
  detail?: string;
  tone?: GaugeTone;
  /** Tự đổi màu theo ngưỡng (≥ warn: warning, ≥ danger: danger). */
  thresholds?: { warn: number; danger: number };
  size?: number;
  className?: string;
}

const STROKE: Record<GaugeTone, string> = {
  primary: 'stroke-chart-1',
  success: 'stroke-chart-2',
  accent: 'stroke-chart-3',
  warning: 'stroke-chart-4',
  info: 'stroke-chart-5',
  danger: 'stroke-danger',
};

/** Đồng hồ vòng tròn như mockup dashboard; có role="meter" cho screen reader. */
export function Gauge({
  value,
  label,
  detail,
  tone = 'primary',
  thresholds,
  size = 112,
  className,
}: Props) {
  const v = Math.max(0, Math.min(100, value));
  const effective: GaugeTone = thresholds
    ? v >= thresholds.danger
      ? 'danger'
      : v >= thresholds.warn
        ? 'warning'
        : tone
    : tone;
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-valuetext={`${Math.round(v)}%${detail ? ` (${detail})` : ''}`}
      className={cn('flex flex-col items-center gap-2', className)}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
          <circle cx="50" cy="50" r={r} fill="none" strokeWidth="9" className="stroke-surface-2" />
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            strokeWidth="9"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - v / 100)}
            className={cn(STROKE[effective], 'transition-[stroke-dashoffset] duration-500')}
          />
        </svg>
        <span className="absolute inset-0 grid place-items-center text-xl font-semibold tabular-nums">
          {Math.round(v)}%
        </span>
      </div>
      <div className="text-center">
        <p className="text-sm font-medium">{label}</p>
        {detail && <p className="text-xs text-muted tabular-nums">{detail}</p>}
      </div>
    </div>
  );
}
