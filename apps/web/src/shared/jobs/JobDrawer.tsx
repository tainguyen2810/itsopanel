import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { PortalSchemas } from '@/api/portal';
import { ErrorState } from '@/shared/page/states';
import { Drawer, DrawerContent } from '@/ui/Dialog';
import { Alert } from '@/ui/Alert';
import { Skeleton } from '@/ui/Feedback';
import { JobProgress } from '@/ui/JobProgress';
import { explainJobError } from './jobErrors';
import { setJobDrawerOpen, useJobDrawer } from './jobStore';

/** Job (schema chung trong common.yaml, giống nhau ở admin và portal). */
export type Job = PortalSchemas['Job'];

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export function jobStatus(state: Job['state']) {
  if (state === 'cancel_requested') return 'running' as const;
  return state as 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}

/** Tiến độ job (dùng trong drawer và trang chi tiết job). Job lỗi có giải thích dễ hiểu theo mã lỗi. */
export function JobView({ job, title }: { job: Job; title?: string }) {
  const { t } = useTranslation('common');
  const explained = job.state === 'failed' ? explainJobError(job.error?.code) : null;
  return (
    <div className="flex flex-col gap-3">
      <JobProgress
        title={title ?? (t(`events.${job.type}` as never, { defaultValue: job.type }) as string)}
        status={jobStatus(job.state)}
        steps={job.steps.map((s) => ({
          op: s.op,
          label: t(`ops.${s.op}` as never, { defaultValue: s.op }) as string,
          state: s.state === 'cancelled' ? ('skipped' as const) : s.state,
          ...(job.error?.step === s.seq ? { detail: job.error.message } : {}),
        }))}
      />
      {job.state === 'failed' && job.error ? (
        <Alert
          tone="danger"
          title={explained ? t(`jobErrors.${explained}.title`) : t('jobErrors.generic')}
        >
          {explained ? <p>{t(`jobErrors.${explained}.hint`)}</p> : null}
          <p className="font-mono text-xs wrap-anywhere" data-testid="job-error-message">
            {job.error.code}: {job.error.message}
          </p>
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * Drawer toàn cục theo dõi job: tự làm mới tới khi job kết thúc, báo toast và làm mới dữ liệu
 * các trang (invalidate cache) khi xong.
 */
export function JobDrawerHost({ fetchJob }: { fetchJob: (uuid: string) => Promise<Job> }) {
  const { t } = useTranslation('common');
  const { uuid, open } = useJobDrawer();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['job', uuid],
    queryFn: () => fetchJob(uuid as string),
    enabled: uuid !== null,
    refetchInterval: (query) =>
      query.state.data && TERMINAL.has(query.state.data.state) ? false : 800,
  });
  const announced = useRef<string | null>(null);
  const job = q.data;
  useEffect(() => {
    if (!job || !TERMINAL.has(job.state) || announced.current === job.uuid) return;
    announced.current = job.uuid;
    const type = t(`events.${job.type}` as never, { defaultValue: job.type }) as string;
    if (job.state === 'succeeded') toast.success(t('job.done', { type }));
    else if (job.state === 'failed') toast.error(t('job.failed', { type }));
    void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'job' });
  }, [job, qc, t]);

  return (
    <Drawer open={open && uuid !== null} onOpenChange={setJobDrawerOpen}>
      <DrawerContent side="right" title={t('job.track')} description={uuid ?? undefined}>
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <JobView job={q.data} />
        )}
      </DrawerContent>
    </Drawer>
  );
}
