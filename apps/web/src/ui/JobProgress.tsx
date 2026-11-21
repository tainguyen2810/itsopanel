import { CheckCircle2, Circle, CircleX, LoaderCircle, MinusCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { StatusBadge } from './Badge';
import { ProgressBar } from './ProgressBar';

export type StepState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface JobStep {
  /** Tên op agent, vd. nginx.vhost.apply. */
  op: string;
  label: string;
  state: StepState;
  detail?: string;
}

interface Props {
  title: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  steps: JobStep[];
  className?: string;
}

const ICON = {
  pending: { icon: Circle, cls: 'text-subtle' },
  running: { icon: LoaderCircle, cls: 'animate-spin text-info-text' },
  succeeded: { icon: CheckCircle2, cls: 'text-success-text' },
  failed: { icon: CircleX, cls: 'text-danger-text' },
  skipped: { icon: MinusCircle, cls: 'text-subtle' },
} as const;

/** Tiến độ Job (202 + JobAccepted): danh sách bước theo op agent và thanh tiến độ. */
export function JobProgress({ title, status, steps, className }: Props) {
  const { t } = useTranslation('common');
  const done = steps.filter((s) => s.state === 'succeeded' || s.state === 'skipped').length;
  const current = Math.min(steps.length, done + (status === 'running' ? 1 : 0));
  return (
    <section aria-label={title} className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium">{title}</h4>
        <StatusBadge status={status} />
      </div>
      <ProgressBar
        label={t('job.step', { current, total: steps.length })}
        value={done}
        max={steps.length}
        tone={status === 'failed' ? 'danger' : status === 'succeeded' ? 'success' : 'primary'}
      />
      <p className="text-xs text-muted">{t('job.step', { current, total: steps.length })}</p>
      <ol aria-label={t('job.steps')} className="flex flex-col gap-2">
        {steps.map((s, i) => {
          const { icon: Icon, cls } = ICON[s.state];
          return (
            // Một job có thể lặp op (vd. backup.run cho file rồi cho DB): khóa theo vị trí bước.
            <li key={`${i}:${s.op}`} className="flex items-start gap-2.5" data-state={s.state}>
              <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', cls)} />
              <div className="min-w-0">
                <p className={cn('text-base', s.state === 'pending' && 'text-muted')}>{s.label}</p>
                <p className="font-mono text-xs wrap-anywhere text-subtle">
                  {s.op}
                  {s.detail ? ` · ${s.detail}` : ''}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
