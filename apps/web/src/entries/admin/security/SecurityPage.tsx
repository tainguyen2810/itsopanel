import { useQuery } from '@tanstack/react-query';
import { Ban, Bug, ShieldAlert, Siren } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { Badge, SeverityBadge, StatusBadge, type Severity } from '@/ui/Badge';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Gauge } from '@/ui/Gauge';
import { StatCard } from '@/ui/StatCard';
import { get, list } from '../api';
import { SecurityNav, useEventColumns, type SecEvent } from './common';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export default function SecurityPage() {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const fmt = useFmt();
  const ov = useQuery({
    queryKey: ['admin', 'security', 'overview'],
    queryFn: () => get('/api/v1/admin/security/overview'),
  });
  const columns = useEventColumns();
  const o = ov.data;
  const ev = o?.events_24h ?? {};
  return (
    <ListPage<SecEvent>
      title={t('sec.title')}
      description={t('sec.description')}
      queryKey={['admin', 'security', 'events']}
      fetch={(q) => list('/api/v1/admin/security/events', q)}
      filters={[
        {
          key: 'severity',
          label: t('sec.severity'),
          options: SEVERITIES.map((s) => ({ value: s, label: tc(`severity.${s}`) })),
        },
      ]}
      columns={columns}
      getRowId={(e) => e.uuid}
      primaryColumnId="message"
      nav={<SecurityNav current="overview" />}
    >
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title={t('sec.score')}
            description={o ? t('sec.updated', { at: fmt.rel(o.updated_at) }) : ''}
          />
          <CardContent className="flex flex-col items-center gap-2">
            <Gauge
              value={o?.score ?? 0}
              label={t('sec.score')}
              detail={o ? t('sec.grade', { grade: o.grade }) : ''}
              tone={
                (o?.score ?? 0) >= 80 ? 'success' : (o?.score ?? 0) >= 60 ? 'warning' : 'danger'
              }
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('sec.checks')} description={t('sec.checksHint')} />
          <CardContent>
            <ul className="divide-y divide-border">
              {(o?.checks ?? []).map((c) => (
                <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 flex-1">
                    {t(`sec.check.${c.key}` as never, { defaultValue: c.title })}
                  </span>
                  <span className="flex items-center gap-2">
                    <SeverityBadge severity={c.severity as Severity} />
                    <StatusBadge status={c.status} />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Siren}
          tone="danger"
          label={t('sec.criticalHigh')}
          value={String((ev.critical ?? 0) + (ev.high ?? 0))}
          hint={t('sec.last24h')}
        />
        <StatCard
          icon={ShieldAlert}
          tone="warning"
          label={t('sec.mediumLow')}
          value={String((ev.medium ?? 0) + (ev.low ?? 0))}
          hint={t('sec.last24h')}
        />
        <StatCard
          icon={Ban}
          tone="info"
          label={t('sec.blockedIps')}
          value={String(o?.blocked_ips_24h ?? '—')}
          hint={t('sec.last24h')}
        />
        <StatCard
          icon={Bug}
          tone={(o?.malware_findings_open ?? 0) > 0 ? 'danger' : 'success'}
          label={t('sec.malwareOpen')}
          value={String(o?.malware_findings_open ?? '—')}
        />
      </div>
      <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold">
        {t('sec.events')}
        <Badge tone="neutral">{t('sec.eventsHint')}</Badge>
      </h2>
    </ListPage>
  );
}
