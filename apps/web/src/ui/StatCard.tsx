import type { LucideIcon } from 'lucide-react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import type { Tone } from './Badge';
import { Card } from './Card';

const ICON_TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  primary: 'bg-primary-soft text-primary-text',
  accent: 'bg-accent-soft text-accent-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  info: 'bg-info-soft text-info-text',
};

interface Props {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: Tone;
  /** Chênh lệch so với kỳ trước, vd "+2" hoặc "-3,1%". */
  delta?: { value: string; direction: 'up' | 'down'; positive?: boolean };
  hint?: string;
  className?: string;
}

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = 'primary',
  delta,
  hint,
  className,
}: Props) {
  const good = delta ? (delta.positive ?? delta.direction === 'up') : true;
  return (
    <Card className={cn('flex items-center gap-4 p-4', className)}>
      <span className={cn('grid size-11 shrink-0 place-items-center rounded-lg', ICON_TONE[tone])}>
        <Icon aria-hidden className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm text-muted">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {(delta ?? hint) && (
          <p className="flex items-center gap-1 text-xs text-muted">
            {delta && (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5',
                  good ? 'text-success-text' : 'text-danger-text',
                )}
              >
                {delta.direction === 'up' ? (
                  <TrendingUp aria-hidden className="size-3" />
                ) : (
                  <TrendingDown aria-hidden className="size-3" />
                )}
                {delta.value}
              </span>
            )}
            {hint}
          </p>
        )}
      </div>
    </Card>
  );
}
