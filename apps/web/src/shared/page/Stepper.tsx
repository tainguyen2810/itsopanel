import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';

interface Props {
  steps: string[];
  current: number;
  label: string;
  /** Cho bấm quay lại bước đã qua. */
  onSelect?: (i: number) => void;
  className?: string;
}

/** Thanh bước của wizard: ngang ở màn rộng, chỉ "Bước x/y" + tên bước ở màn hẹp. */
export function Stepper({ steps, current, label, onSelect, className }: Props) {
  const { t } = useTranslation('common');
  return (
    <nav aria-label={label} className={cn('mb-4', className)}>
      <p className="text-sm text-muted sm:hidden">
        {t('wizard.stepOf', { current: current + 1, total: steps.length })} ·{' '}
        <span className="font-medium text-fg">{steps[current]}</span>
      </p>
      <ol className="hidden flex-wrap items-center gap-2 sm:flex">
        {steps.map((s, i) => {
          const done = i < current;
          const content = (
            <>
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full border text-xs',
                  done
                    ? 'border-success bg-success text-success-fg'
                    : i === current
                      ? 'border-primary text-primary-text'
                      : 'border-border-strong',
                )}
              >
                {done ? <Check aria-hidden className="size-3.5" /> : i + 1}
              </span>
              {s}
            </>
          );
          const cls = cn(
            'flex items-center gap-2 rounded-md px-2 py-1 text-base',
            i === current ? 'bg-primary-soft font-medium text-primary-text' : 'text-muted',
          );
          return (
            <li key={s} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="h-px w-4 bg-border-strong" />}
              {done && onSelect ? (
                <button
                  type="button"
                  className={cn(cls, 'cursor-pointer hover:bg-surface-hover hover:text-fg')}
                  onClick={() => onSelect(i)}
                >
                  {content}
                </button>
              ) : (
                <span className={cls} aria-current={i === current ? 'step' : undefined}>
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
