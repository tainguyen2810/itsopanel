import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HardDrive,
  Loader2,
  Lock,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ErrorState } from '@/shared/page/states';
import { AppLink } from '@/ui/AppLink';
import { Badge } from '@/ui/Badge';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { ProgressBar } from '@/ui/ProgressBar';
import { StatCard } from '@/ui/StatCard';
import { get } from '../api';

/** Tổng quan Backup Center: 3-2-1-1-0 (tính ở panel từ dữ kiện thật), đích, job đang chạy, quota (D-86, D-87). */
export function OverviewTab() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'backups', 'overview'],
    queryFn: () => get('/api/v1/admin/backups/overview'),
    refetchInterval: 5000,
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  const passed = o?.rules.filter((r) => r.ok).length ?? 0;
  const maxUsed = Math.max(1, ...(o?.destinations.map((d) => d.used_mb) ?? [1]));
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('bk.ov.lastBackup')}
          value={o?.last_backup_at ? fmt.rel(o.last_backup_at) : '—'}
          icon={HardDrive}
          {...(o?.last_backup_at ? { hint: fmt.dateTime(o.last_backup_at) } : {})}
        />
        <StatCard
          label={t('bk.ov.lastVerified')}
          value={o?.last_verified_at ? fmt.rel(o.last_verified_at) : '—'}
          icon={ShieldCheck}
          tone="success"
          {...(o?.last_verified_at ? { hint: fmt.dateTime(o.last_verified_at) } : {})}
        />
        <StatCard
          label={t('bk.ov.running')}
          value={String(o?.running.length ?? 0)}
          icon={Loader2}
          tone="info"
        />
        <StatCard
          label={t('bk.ov.failed24h')}
          value={String(o?.failed_24h ?? 0)}
          icon={AlertTriangle}
          tone={(o?.failed_24h ?? 0) > 0 ? 'danger' : 'neutral'}
        />
      </div>

      <Card>
        <CardHeader
          title={t('bk.rule.title')}
          description={
            o ? t('bk.rule.summary', { passed, total: o.rules.length }) : t('bk.rule.hint')
          }
        />
        <CardContent>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            {(o?.rules ?? []).map((r) => (
              <li key={r.key} className="flex gap-2 rounded-lg border border-border p-3">
                {r.ok ? (
                  <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-success-text" />
                ) : (
                  <XCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-danger-text" />
                )}
                <div className="min-w-0">
                  <p className="font-medium">
                    <span className="sr-only">{r.ok ? t('bk.rule.ok') : t('bk.rule.fail')}: </span>
                    {t(`bk.rule.${r.key}.title`)}
                  </p>
                  <p className="text-sm text-muted">
                    {t(`bk.rule.${r.key}.value`, { count: r.value })}
                  </p>
                  {r.reason && <p className="mt-1 text-sm text-danger-text">{r.reason}</p>}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t('bk.ov.destTitle')} description={t('bk.ov.destHint')} />
          <CardContent>
            <ul className="flex flex-col gap-4">
              {(o?.destinations ?? []).map((d) => (
                <li key={d.uuid} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {d.name}
                      <Badge tone="neutral">{t(`bk.types.${d.type}`)}</Badge>
                      {d.immutable && (
                        <Badge tone="success">
                          <Lock aria-hidden className="size-3.5" />
                          {t('bk.ov.immutable')}
                        </Badge>
                      )}
                      {d.last_check_ok === false && (
                        <Badge tone="danger">{t('bk.checkFail')}</Badge>
                      )}
                    </span>
                    <span className="text-sm tabular-nums text-muted">{fmt.mb(d.used_mb)}</span>
                  </div>
                  <ProgressBar
                    value={d.used_mb}
                    max={maxUsed}
                    label={t('bk.ov.usedOf', { name: d.name })}
                    tone={d.last_check_ok === false ? 'danger' : 'primary'}
                  />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title={t('bk.ov.runningTitle')} />
            <CardContent>
              {o && o.running.length === 0 ? (
                <p className="text-sm text-muted">{t('bk.ov.noRunning')}</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {(o?.running ?? []).map((j) => (
                    <li key={j.job_uuid} className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <AppLink
                          href={`/admin/jobs/${j.job_uuid}`}
                          className="font-medium hover:underline"
                        >
                          {t(`bk.ov.jobType.${j.type}` as never, { defaultValue: j.type })}
                        </AppLink>
                        <span className="flex items-center gap-1 text-sm text-muted">
                          <Clock aria-hidden className="size-3.5" />
                          {fmt.rel(j.started_at)}
                        </span>
                      </div>
                      <ProgressBar
                        value={j.progress}
                        label={t('bk.ov.progressOf', { name: j.type })}
                        showValue
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader title={t('bk.ov.quotaTitle')} description={t('bk.ov.quotaHint')} />
            <CardContent>
              {o && o.quota.length === 0 ? (
                <p className="text-sm text-muted">{t('bk.ov.noQuota')}</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {(o?.quota ?? []).map((a) => (
                    <li key={a.hosting_account.uuid} className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <AppLink
                          href={`/admin/hosting-accounts/${a.hosting_account.uuid}?tab=backup`}
                          className="font-mono font-medium hover:underline"
                        >
                          {a.hosting_account.username}
                        </AppLink>
                        <Badge tone={a.state === 'paused' ? 'danger' : 'warning'}>
                          {t(`bk.quota.${a.state}`)}
                        </Badge>
                      </div>
                      <ProgressBar
                        value={a.used_mb}
                        max={a.limit_mb}
                        label={t('bk.ov.quotaOf', { name: a.hosting_account.username })}
                        tone={a.state === 'paused' ? 'danger' : 'warning'}
                      />
                      <p className="text-sm text-muted">
                        {t('bk.quotaUsed', {
                          used: fmt.mb(a.used_mb),
                          limit: fmt.mb(a.limit_mb),
                        })}
                        {a.state === 'paused' && ` · ${t('bk.quota.pausedHint')}`}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
