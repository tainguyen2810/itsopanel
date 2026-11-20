import { cn } from '@/shared/lib/utils';

type Tone = 'primary' | 'success' | 'warning' | 'danger' | 'accent' | 'info';
const BAR: Record<Tone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  accent: 'bg-accent',
  info: 'bg-info',
};

interface Props {
  value: number;
  max?: number;
  label: string;
  showValue?: boolean;
  tone?: Tone;
  thresholds?: { warn: number; danger: number };
  className?: string;
}

export function ProgressBar({
  value,
  max = 100,
  label,
  showValue = false,
  tone = 'primary',
  thresholds,
  className,
}: Props) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const t: Tone = thresholds
    ? pct >= thresholds.danger
      ? 'danger'
      : pct >= thresholds.warn
        ? 'warning'
        : tone
    : tone;
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', BAR[t])}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showValue && (
        <span className="w-10 text-right text-xs text-muted tabular-nums">{Math.round(pct)}%</span>
      )}
    </div>
  );
}
