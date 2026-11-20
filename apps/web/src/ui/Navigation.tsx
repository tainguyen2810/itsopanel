import { Fragment } from 'react';
import { ChevronLeft, ChevronRight, ChevronRight as Sep } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { AppLink } from './AppLink';
import { Button } from './Button';

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumb({ items, className }: { items: Crumb[]; className?: string }) {
  const { t } = useTranslation('common');
  return (
    <nav aria-label={t('breadcrumb')} className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <Fragment key={`${c.label}-${i}`}>
              <li>
                {last || c.href === undefined ? (
                  <span
                    aria-current={last ? 'page' : undefined}
                    className={cn(last && 'font-medium text-fg')}
                  >
                    {c.label}
                  </span>
                ) : (
                  <AppLink href={c.href} className="hover:text-fg hover:underline">
                    {c.label}
                  </AppLink>
                )}
              </li>
              {!last && (
                <li aria-hidden>
                  <Sep className="size-3.5" />
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

interface PaginationProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  className?: string;
}

/** Phân trang theo số trang (1-based). API thật dùng cursor; DataTable phân trang phía client. */
export function Pagination({ page, pageCount, onPageChange, className }: PaginationProps) {
  const { t } = useTranslation('common');
  const total = Math.max(1, pageCount);
  return (
    <nav aria-label={t('pagination')} className={cn('flex items-center gap-2', className)}>
      <Button
        variant="outline"
        size="icon"
        aria-label={t('table.previous')}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft aria-hidden />
      </Button>
      <span className="text-sm text-muted tabular-nums" aria-live="polite">
        {t('table.page', { page, total })}
      </span>
      <Button
        variant="outline"
        size="icon"
        aria-label={t('table.next')}
        disabled={page >= total}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight aria-hidden />
      </Button>
    </nav>
  );
}
