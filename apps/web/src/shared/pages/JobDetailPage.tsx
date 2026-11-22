import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { RotateCcw, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/http';
import { useFmt } from '@/shared/format/useFmt';
import { JobView } from '@/shared/jobs/JobDrawer';
import { useJobEvents } from '@/shared/jobs/useJobEvents';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { useCrumbName } from '@/shared/routing/crumbs';
import { useRoutesInfo } from '@/shared/routing/RoutesContext';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { EmptyState } from '@/ui/Feedback';
import { ScrollText } from 'lucide-react';
import { get, send, type JobAccepted } from '@/shared/api/realm';
import { auditLabel, resourceHref } from '@/shared/lib/labels';

const ACTIVE = new Set(['queued', 'running', 'cancel_requested']);
const RETRYABLE = new Set(['failed', 'cancelled', 'timed_out']);

export default function JobDetailPage() {
  const { t } = useTranslation('admin');
  const { realm } = useRoutesInfo();
  const fmt = useFmt();
  const navigate = useNavigate();
  const { id } = useParams({ strict: false }) as { id: string };
  const qc = useQueryClient();
  const cached = qc.getQueryData<{ state: string; links: { events: string } }>([
    'admin',
    'job',
    id,
  ]);
  // SSE (D-106): đang có luồng thì không poll trạng thái job; lỗi luồng → poll 1 giây như cũ.
  const live = useJobEvents(id, cached?.links.events, cached ? !ACTIVE.has(cached.state) : false, [
    'admin',
    'job',
    id,
  ]);
  const job = useQuery({
    queryKey: ['admin', 'job', id],
    queryFn: () => get('/jobs/{id}', { path: { id } }),
    refetchInterval: (q) =>
      !live && q.state.data && ACTIVE.has(q.state.data.state) ? 1000 : false,
  });
  const logs = useQuery({
    queryKey: ['admin', 'job', id, 'logs'],
    queryFn: () => get('/jobs/{id}/logs', { path: { id }, query: { limit: 200 } }),
    refetchInterval: () => (job.data && ACTIVE.has(job.data.state) ? 1500 : false),
  });
  const title = job.data ? auditLabel(t, job.data.type) : undefined;
  useCrumbName(id, title);

  const onError = (e: unknown) => toast.error(e instanceof ApiError ? e.problem.title : String(e));
  const cancel = useMutation({
    mutationFn: () => send('POST', '/jobs/{id}:cancel', { path: { id } }),
    onSuccess: () => {
      toast.success(t('jobs.cancelRequested'));
      void job.refetch();
    },
    onError,
  });
  const retry = useMutation({
    mutationFn: () => send<JobAccepted>('POST', '/jobs/{id}:retry', { path: { id } }),
    onSuccess: (r) => void navigate({ to: '/jobs/$id', params: { id: r.job.uuid } }),
    onError,
  });

  if (job.isPending) return <PageSkeleton />;
  if (job.isError) {
    return (
      <>
        <PageHeader title={t('jobs.detail')} />
        <ErrorState error={job.error} onRetry={() => void job.refetch()} />
      </>
    );
  }
  const j = job.data;
  const res = resourceHref(j.resource, realm);
  const info: [string, React.ReactNode][] = [
    [
      t('jobs.uuid'),
      <code key="u" className="font-mono text-sm wrap-anywhere">
        {j.uuid}
      </code>,
    ],
    [
      t('jobs.resource'),
      j.resource ? (
        res ? (
          <AppLink href={res} className="text-primary-text hover:underline">
            {j.resource.type} · {j.resource.uuid.slice(0, 8)}…
          </AppLink>
        ) : (
          `${j.resource.type} · ${j.resource.uuid.slice(0, 8)}…`
        )
      ) : (
        '—'
      ),
    ],
    [t('jobs.server'), j.server?.name ?? '—'],
    [t('jobs.requestedBy'), j.requested_by?.name ?? '—'],
    [t('jobs.attempts'), `${j.attempts} / ${j.max_attempts}`],
    [t('jobs.timeout'), t('jobs.seconds', { count: j.timeout_sec })],
    [t('jobs.created'), fmt.dateTime(j.created_at)],
    [t('jobs.started'), fmt.opt(j.started_at)],
    [t('jobs.finished'), fmt.opt(j.finished_at)],
  ];

  return (
    <>
      <PageHeader
        title={title ?? j.type}
        meta={<StatusBadge status={j.state} />}
        description={j.error ? `${j.error.message} (${j.error.code})` : undefined}
        actions={
          <>
            {ACTIVE.has(j.state) && j.state !== 'cancel_requested' && (
              <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <Square aria-hidden />
                {t('jobs.cancel')}
              </Button>
            )}
            {RETRYABLE.has(j.state) && (
              <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
                <RotateCcw aria-hidden />
                {t('jobs.retry')}
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent>
            <JobView job={j} title={t('jobs.steps')} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('jobs.info')} />
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base">
              {info.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="min-w-0">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title={t('jobs.logs')} />
        <CardContent>
          {logs.data && logs.data.length > 0 ? (
            <ol
              className="max-h-96 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-sm"
              aria-label={t('jobs.logs')}
            >
              {logs.data.map((l, i) => (
                <li key={i} className="flex gap-3 py-0.5">
                  <span className="shrink-0 text-subtle">{fmt.dateTime(l.at)}</span>
                  <span className="shrink-0 text-muted">#{l.seq}</span>
                  <span
                    className={
                      l.level === 'error'
                        ? 'text-danger-text'
                        : l.level === 'warn'
                          ? 'text-warning-text'
                          : ''
                    }
                  >
                    {l.message}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState icon={ScrollText} title={t('jobs.noLogs')} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
