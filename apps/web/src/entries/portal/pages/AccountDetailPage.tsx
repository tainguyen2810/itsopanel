import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, list } from '@/shared/api/realm';
import { useFmt } from '@/shared/format/useFmt';
import { Mono, useFeatures, useRouteId } from '@/shared/hosting/pages/common';
import { UsageList } from '@/shared/hosting/pages/usage';
import { InfoList } from '@/shared/page/InfoList';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton, TableSkeleton } from '@/shared/page/states';
import { useCrumbName } from '@/shared/routing/crumbs';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Card, CardContent, CardHeader } from '@/ui/Card';

/** Gói hosting của tôi: thông tin account, usage so với quota, tính năng gói, website. */
export default function AccountDetailPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const id = useRouteId();
  const q = useQuery({
    queryKey: ['portal', 'account', id],
    queryFn: () => get('/hosting-accounts/{id}', { path: { id } }),
  });
  const features = useFeatures(id);
  const sites = useQuery({
    queryKey: ['portal', 'account', id, 'websites'],
    queryFn: () => list('/websites', { filters: { hosting_account: id } }),
  });
  useCrumbName(id, q.data?.username);
  if (q.isPending) return <PageSkeleton />;
  if (q.isError)
    return (
      <>
        <PageHeader title={t('pt.account')} />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  const a = q.data;
  const f = features.data;
  const retention = f
    ? Object.entries(f.backup_retention)
        .map(([k, v]) => t('pt.retention', { count: v, unit: t(`pt.units.${k}` as never) }))
        .join(', ')
    : '—';
  return (
    <>
      <PageHeader
        title={a.username}
        meta={<StatusBadge status={a.lifecycle_state} />}
        description={t('pt.accountHint', { name: a.package.name })}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Card>
            <CardHeader title={t('pt.usage')} description={t('pt.usageHint')} />
            <CardContent>
              <UsageList usage={a.usage} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader title={t('pt.websites')} />
            <CardContent>
              {sites.data === undefined ? (
                <TableSkeleton rows={2} />
              ) : sites.data.length === 0 ? (
                <p className="text-base text-muted">{t('pt.noWebsites')}</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {sites.data.map((w) => (
                    <li key={w.uuid} className="flex items-center justify-between gap-3 py-2">
                      <AppLink
                        href={`/portal/websites/${w.uuid}`}
                        className="min-w-0 font-medium break-all hover:underline"
                      >
                        {w.primary_domain}
                      </AppLink>
                      <StatusBadge status={w.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('pt.info')} />
            <CardContent>
              <InfoList
                items={[
                  [t('pt.package'), `${a.package.name} (v${a.package.version})`],
                  [t('pt.home'), <Mono key="h">{a.home_path}</Mono>],
                  [t('pt.since'), fmt.date(a.created_at)],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader title={t('pt.features')} />
            <CardContent>
              {!f ? (
                <TableSkeleton rows={3} />
              ) : (
                <InfoList
                  items={[
                    [
                      'PHP',
                      <span key="p" className="flex flex-wrap justify-end gap-1">
                        {f.php_versions.map((v) => (
                          <Badge key={v} tone="neutral">
                            {v}
                          </Badge>
                        ))}
                      </span>,
                    ],
                    [
                      'SSH',
                      <Badge key="s" tone={f.ssh_allowed ? 'success' : 'neutral'}>
                        {f.ssh_allowed ? t('pt.yes') : t('pt.no')}
                      </Badge>,
                    ],
                    [t('pt.cronMin'), t('pt.minutes', { count: f.cron_min_interval_min })],
                    [t('pt.backupQuota'), fmt.mb(f.backup_quota_mb)],
                    [t('pt.backupRetention'), retention],
                  ]}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
