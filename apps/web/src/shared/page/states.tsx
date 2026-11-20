import { CircleAlert, FileQuestion, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/http';
import { Button } from '@/ui/Button';
import { EmptyState, Skeleton } from '@/ui/Feedback';

/** Khung đang tải của một trang (tiêu đề + vài khối). */
export function PageSkeleton() {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <span className="sr-only" role="status">
        {t('state.loading')}
      </span>
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-8 w-72 max-w-full" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

/** Dòng skeleton cho bảng. */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <span className="sr-only" role="status">
        {t('state.loading')}
      </span>
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

/** Lỗi từ API (Problem). 403 hiện trạng thái không có quyền. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation('common');
  const problem = error instanceof ApiError ? error.problem : undefined;
  if (problem?.status === 403) return <ForbiddenState />;
  return (
    <div role="alert" className="rounded-lg border border-border">
      <EmptyState
        icon={CircleAlert}
        title={problem?.title ?? t('state.error')}
        description={
          problem
            ? `${problem.detail ?? ''} (${problem.code}, HTTP ${problem.status})`.trim()
            : undefined
        }
        action={
          onRetry ? (
            <Button variant="outline" onClick={onRetry}>
              {t('actions.retry')}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

function ForbiddenState() {
  const { t } = useTranslation('common');
  return (
    <div className="rounded-lg border border-border">
      <EmptyState
        icon={ShieldOff}
        title={t('state.forbidden')}
        description={t('state.forbiddenHint')}
      />
    </div>
  );
}

/** Trang 403 thân thiện khi vai trò hiện tại không được vào route. */
export function ForbiddenPage() {
  const { t } = useTranslation('common');
  return (
    <section aria-labelledby="forbidden-title" className="py-10">
      <EmptyState
        icon={ShieldOff}
        title={
          <span id="forbidden-title" role="heading" aria-level={1}>
            {t('state.forbidden')}
          </span>
        }
        description={t('state.forbiddenHint')}
        action={
          <Button variant="outline" onClick={() => window.history.back()}>
            {t('actions.back')}
          </Button>
        }
      />
    </section>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation('common');
  return (
    <section className="py-10">
      <EmptyState
        icon={FileQuestion}
        title={
          <span role="heading" aria-level={1}>
            {t('state.notFound')}
          </span>
        }
        description={t('state.notFoundHint')}
      />
    </section>
  );
}
