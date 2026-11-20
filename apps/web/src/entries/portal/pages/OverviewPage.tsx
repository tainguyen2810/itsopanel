import { useQuery } from '@tanstack/react-query';
import { Archive, Bell, Server, Database, FolderOpen, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { get } from '@/shared/api/realm';
import { auditLabel } from '@/shared/lib/labels';
import { UsageList } from '@/shared/hosting/pages/usage';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import { buttonVariants } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { EmptyState } from '@/ui/Feedback';

const TONE = {
  info: 'info',
  low: 'info',
  medium: 'warning',
  high: 'danger',
  critical: 'danger',
} as const;

/** Tổng quan Portal: usage so với quota của từng account, cảnh báo, thao tác gần đây. */
export default function OverviewPage() {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const q = useQuery({ queryKey: ['portal', 'overview'], queryFn: () => get('/overview') });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError)
    return (
      <>
        <PageHeader title={t('pt.overview')} />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  const o = q.data;
  const quick = [
    { href: '/portal/websites', icon: Globe, label: t('pt.quick.websites') },
    { href: '/portal/databases', icon: Database, label: t('pt.quick.databases') },
    { href: '/portal/files', icon: FolderOpen, label: t('pt.quick.files') },
    { href: '/portal/backups', icon: Archive, label: t('pt.quick.backups') },
  ];
  return (
    <>
      <PageHeader
        title={t('pt.hello', { name: user.name })}
        description={t('pt.overviewHint')}
        actions={
          <AppLink href="/portal/notifications" className={buttonVariants({ variant: 'outline' })}>
            <Bell aria-hidden />
            {t('pt.unread', { count: o.notifications_unread })}
          </AppLink>
        }
      />
      <div className="flex flex-col gap-4">
        {o.warnings.length > 0 && (
          <section aria-label={t('pt.warnings')} className="flex flex-col gap-2">
            {o.warnings.map((w) => (
              <Alert key={`${w.code}-${w.message}`} tone={TONE[w.severity]} title={w.message} />
            ))}
          </section>
        )}
        <nav aria-label={t('pt.quickLinks')} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {quick.map(({ href, icon: Icon, label }) => (
            <AppLink
              key={href}
              href={href}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface p-3 font-medium hover:bg-surface-hover"
            >
              <Icon aria-hidden className="size-5 text-primary" />
              {label}
            </AppLink>
          ))}
        </nav>
        {o.accounts.length === 0 ? (
          <EmptyState
            icon={Server}
            title={t('pt.noAccounts')}
            description={t('pt.noAccountsHint')}
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {o.accounts.map((a) => (
              <Card key={a.hosting_account.uuid} data-testid="portal-account">
                <CardHeader
                  title={a.hosting_account.username}
                  description={t('pt.usageHint')}
                  action={
                    <span className="flex items-center gap-2">
                      <StatusBadge status={a.lifecycle_state} />
                      <AppLink
                        href={`/portal/accounts/${a.hosting_account.uuid}`}
                        className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        aria-label={t('pt.viewAccount', { name: a.hosting_account.username })}
                      >
                        {t('pt.details')}
                      </AppLink>
                    </span>
                  }
                />
                <CardContent>
                  <UsageList usage={a.usage} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        <Card>
          <CardHeader title={t('pt.recentJobs')} />
          <CardContent>
            {o.recent_jobs.length === 0 ? (
              <p className="text-base text-muted">{t('pt.noJobs')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {o.recent_jobs.map((j) => (
                  <li key={j.uuid} className="flex items-center justify-between gap-3 py-2">
                    <AppLink href={`/portal/jobs/${j.uuid}`} className="min-w-0 hover:underline">
                      {auditLabel(t, j.type)}
                    </AppLink>
                    <span className="flex shrink-0 items-center gap-2">
                      {j.state === 'running' && (
                        <span className="text-sm text-muted tabular-nums">{j.progress}%</span>
                      )}
                      <StatusBadge status={j.state} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
