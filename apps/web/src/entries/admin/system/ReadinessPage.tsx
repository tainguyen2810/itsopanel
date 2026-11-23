import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, FlaskConical, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Gauge } from '@/ui/Gauge';
import { StatCard } from '@/ui/StatCard';
import { get, type Data } from '../api';
import { SystemNav } from './SystemNav';

type Readiness = Data<'/api/v1/admin/system/readiness'>;
const GROUPS = ['access', 'backup', 'security', 'updates', 'monitoring'] as const;

/**
 * Sẵn sàng production (D-115): kiểm tự động từ dữ liệu panel (MFA, allowlist, backup bất biến, CIS, bản vá, update
 * dở dang…) và trạng thái Production Gate G1–G8. `v1.0.0` chỉ khi mọi bài Gate có bằng chứng VM (D-47).
 */
export default function ReadinessPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'system', 'readiness'],
    queryFn: () => get('/api/v1/admin/system/readiness'),
  });
  const header = (
    <PageHeader
      title={t('readiness.title')}
      description={t('readiness.description')}
      nav={<SystemNav current="readiness" />}
    />
  );
  if (q.isLoading)
    return (
      <>
        {header}
        <PageSkeleton />
      </>
    );
  if (q.error || !q.data)
    return (
      <>
        {header}
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  const r: Readiness = q.data;
  const count = (s: string) => r.checks.filter((c) => c.status === s).length;
  const gateDone = r.gate.filter((g) => g.status === 'pass').length;
  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <Alert
          tone={r.ready ? 'success' : 'warning'}
          title={r.ready ? t('readiness.ready') : t('readiness.notReady')}
        >
          {t('readiness.checkedAt', { at: fmt.dateTime(r.checked_at) })}
        </Alert>
        <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
          <Card className="grid place-items-center p-4">
            <Gauge
              value={r.score}
              label={t('readiness.score')}
              detail={t('readiness.scoreDetail', { passed: count('pass'), total: r.checks.length })}
              tone={r.score >= 90 ? 'success' : r.score >= 60 ? 'warning' : 'danger'}
            />
          </Card>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={CheckCircle2}
              tone="success"
              label={t('readiness.pass')}
              value={String(count('pass'))}
            />
            <StatCard
              icon={CircleAlert}
              tone="warning"
              label={t('readiness.warn')}
              value={String(count('warn'))}
            />
            <StatCard
              icon={XCircle}
              tone="danger"
              label={t('readiness.fail')}
              value={String(count('fail'))}
            />
            <StatCard
              icon={FlaskConical}
              tone={gateDone === r.gate.length ? 'success' : 'warning'}
              label={t('readiness.gate')}
              value={`${gateDone}/${r.gate.length}`}
              hint={t('readiness.gateHint')}
            />
          </div>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          {GROUPS.map((g) => {
            const checks = r.checks.filter((c) => c.group === g);
            if (!checks.length) return null;
            return (
              <Card key={g}>
                <CardHeader title={t(`readiness.groups.${g}`)} />
                <CardContent>
                  <ul className="flex flex-col divide-y divide-border">
                    {checks.map((c) => (
                      <li
                        key={c.key}
                        className="flex flex-wrap items-start justify-between gap-2 py-2 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{c.title}</p>
                          <p className="text-sm text-muted">{c.detail}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={c.status} />
                          {c.href && c.status !== 'pass' && (
                            <AppLink
                              href={c.href}
                              className="text-sm text-primary-text hover:underline"
                              aria-label={t('readiness.fixFor', { title: c.title })}
                            >
                              {t('readiness.fix')}
                            </AppLink>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
        <Card>
          <CardHeader
            title={t('readiness.gateTitle')}
            description={t('readiness.gateDescription')}
          />
          <CardContent>
            <ul className="grid gap-3 md:grid-cols-2">
              {r.gate.map((g) => (
                <li key={g.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">
                      <span className="font-mono">{g.id}</span> · {g.title}
                    </p>
                    <StatusBadge status={g.status} />
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    {t('readiness.automated')}: {g.automated}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted">{g.evidence_doc}</p>
                  {g.verified_at && (
                    <p className="mt-1 text-sm">
                      {t('readiness.verifiedAt', { at: fmt.dateTime(g.verified_at) })}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
