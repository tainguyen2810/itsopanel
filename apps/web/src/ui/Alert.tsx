import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonX } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

type Tone = 'info' | 'success' | 'warning' | 'danger';
const STYLE: Record<Tone, { box: string; icon: typeof Info }> = {
  info: { box: 'border-info/40 bg-info-soft text-info-text', icon: Info },
  success: { box: 'border-success/40 bg-success-soft text-success-text', icon: CheckCircle2 },
  warning: { box: 'border-warning/40 bg-warning-soft text-warning-text', icon: AlertTriangle },
  danger: { box: 'border-danger/40 bg-danger-soft text-danger-text', icon: OctagonX },
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon } = STYLE[tone];
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-md border px-4 py-3', box, className)}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children !== undefined && <div className="text-sm text-fg/85">{children}</div>}
      </div>
      {action}
    </div>
  );
}
