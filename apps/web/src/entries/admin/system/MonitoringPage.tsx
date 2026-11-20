import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Activity, BellRing, Globe, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SectionNav } from '@/shared/page/SectionNav';
import { PageHeader } from '@/shared/page/PageHeader';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { AreaChart } from '@/ui/Charts';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { ProgressBar } from '@/ui/ProgressBar';
import { Select } from '@/ui/Select';
import { StatCard } from '@/ui/StatCard';
import { get, list, type Row } from '../api';

type Srv = Row<'/api/v1/admin/servers'>;
type Uptime = Row<'/api/v1/admin/uptime-checks'>;
type Range = '1h' | '24h' | '7d';
const METRICS = ['cpu_pct', 'ram_pct', 'disk_pct'] as const;

export function MonitoringNav({ current }: { current: 'overview' | 'alerts' }) {
  const { t } = useTranslation('admin');
  return (
    <SectionNav
      label={t('mon.sections')}
      current={current}
      items={[
        { key: 'overview', href: '/admin/monitoring', label: t('mon.nav.overview') },
        { key: 'alerts', href: '/admin/monitoring/alerts', label: t('mon.nav.alerts') },
      ]}
    />
  );
}

const pct = (used: number, total: number) => (total > 0 ? (used * 100) / total : 0);

export default function MonitoringPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [range, setRange] = useState<Range>('24h');
  const servers = useQuery({
    queryKey: ['admin', 'servers'],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const uptime = useQuery({
    queryKey: ['admin', 'uptime'],
    queryFn: () => list('/api/v1/admin/uptime-checks'),
  });
  const alerts = useQuery({
    queryKey: ['admin', 'alerts'],
    queryFn: () => list('/api/v1/admin/alerts'),
  });
  const [serverId, setServerId] = useState<string | undefined>(undefined);
  const srv = servers.data ?? [];
  const current = serverId ?? srv[0]?.uuid;
  const series = useQueries({
    queries: METRICS.map((metric) => ({
      queryKey: ['admin', 'metrics', current, metric, range],
      queryFn: () =>
        get('/api/v1/admin/metrics/servers/{id}', {
          path: { id: current ?? '' },
          query: { metric, range },
        }),
      enabled: current !== undefined,
    })),
  });
  const byTime = new Map<string, Record<string, number | string>>();
  series.forEach((q, i) => {
    for (const [ts, v] of q.data?.points ?? []) {
      const row = byTime.get(ts) ?? { time: range === '7d' ? fmt.date(ts) : ts.slice(11, 16) };
      row[METRICS[i] as string] = Math.round(v * 10) / 10;
      byTime.set(ts, row);
    }
  });
  const rows = [...byTime.values()];
  const checks = uptime.data ?? [];
  const down = checks.filter((c) => c.last_status === null || c.last_status >= 400).length;
  const avgUptime = checks.length
    ? checks.reduce((a, c) => a + c.uptime_30d, 0) / checks.length
    : 0;
  const firing = (alerts.data ?? []).filter((a) => a.state === 'firing').length;

  const srvColumns: ColumnDef<Srv, unknown>[] = [
    {
      id: 'name',
      header: t('mon.server'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <AppLink
          href={`/admin/servers/${row.original.uuid}`}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </AppLink>
      ),
    },
    ...(['cpu', 'ram', 'disk'] as const).map((k): ColumnDef<Srv, unknown> => ({
      id: k,
      header: t(`mon.${k}`),
      accessorFn: (s) =>
        k === 'cpu'
          ? s.resources.cpu_pct
          : k === 'ram'
            ? pct(s.resources.ram_used_mb, s.resources.ram_mb)
            : pct(s.resources.disk_used_mb, s.resources.disk_mb),
      cell: ({ getValue, row }) => (
        <ProgressBar
          value={getValue<number>()}
          label={t('mon.usageOf', { what: t(`mon.${k}`), name: row.original.name })}
          showValue
          thresholds={{ warn: 75, danger: 90 }}
          className="min-w-28"
        />
      ),
    })),
    {
      id: 'load',
      header: t('mon.load'),
      accessorFn: (s) => s.resources.load_1m,
      cell: ({ getValue }) => fmt.num(getValue<number>(), 2),
    },
    {
      id: 'status',
      header: t('sites.status'),
      accessorKey: 'status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
  ];
  const upColumns: ColumnDef<Uptime, unknown>[] = [
    {
      id: 'site',
      header: t('sites.domain'),
      accessorFn: (c) => c.website.primary_domain,
      cell: ({ row }) => (
        <AppLink
          href={`/admin/websites/${row.original.website.uuid}`}
          className="font-medium break-all hover:underline"
        >
          {row.original.website.primary_domain}
        </AppLink>
      ),
    },
    {
      id: 'status',
      header: t('mon.http'),
      accessorFn: (c) => c.last_status ?? 0,
      cell: ({ row }) => {
        const s = row.original.last_status;
        return (
          <Badge tone={s !== null && s < 400 ? 'success' : 'danger'}>
            {s ?? t('mon.noResponse')}
          </Badge>
        );
      },
    },
    {
      id: 'latency',
      header: t('mon.latency'),
      accessorFn: (c) => c.last_latency_ms ?? -1,
      cell: ({ row }) =>
        row.original.last_latency_ms === null ? '—' : `${fmt.num(row.original.last_latency_ms)} ms`,
    },
    {
      id: 'uptime',
      header: t('mon.uptime30'),
      accessorKey: 'uptime_30d',
      cell: ({ row }) => (
        <span className={row.original.uptime_30d < 99.5 ? 'text-danger-text' : undefined}>
          {fmt.pct(row.original.uptime_30d, 2)}
        </span>
      ),
    },
    {
      id: 'checked',
      header: t('mon.checked'),
      accessorFn: (c) => c.last_checked_at ?? '',
      cell: ({ row }) =>
        row.original.last_checked_at ? fmt.rel(row.original.last_checked_at) : '—',
    },
  ];
  return (
    <>
      <PageHeader
        title={t('mon.title')}
        description={t('mon.description')}
        nav={<MonitoringNav current="overview" />}
      />
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            icon={Server}
            label={t('mon.servers')}
            value={String(srv.length)}
            hint={t('mon.online', { count: srv.filter((s) => s.status === 'ready').length })}
          />
          <StatCard
            icon={BellRing}
            tone={firing > 0 ? 'danger' : 'success'}
            label={t('mon.firing')}
            value={String(firing)}
          />
          <StatCard
            icon={Globe}
            tone={down > 0 ? 'danger' : 'success'}
            label={t('mon.sitesDown')}
            value={`${down}/${checks.length}`}
          />
          <StatCard
            icon={Activity}
            tone="info"
            label={t('mon.avgUptime')}
            value={checks.length ? fmt.pct(avgUptime, 2) : '—'}
          />
        </div>
        <Card>
          <CardHeader
            title={t('mon.chart')}
            description={t('mon.chartHint')}
            action={
              <div className="flex flex-wrap gap-2">
                <Select
                  aria-label={t('mon.server')}
                  className="w-40"
                  value={current ?? ''}
                  onValueChange={setServerId}
                  options={srv.map((s) => ({ value: s.uuid, label: s.name }))}
                />
                <Select
                  aria-label={t('mon.range')}
                  className="w-32"
                  value={range}
                  onValueChange={(v) => setRange(v as Range)}
                  options={(['1h', '24h', '7d'] as const).map((r) => ({
                    value: r,
                    label: t(`dashboard.ranges.${r}`),
                  }))}
                />
              </div>
            }
          />
          <CardContent>
            <AreaChart
              ariaLabel={t('mon.chartAria', {
                name: srv.find((s) => s.uuid === current)?.name ?? '',
              })}
              data={rows}
              xKey="time"
              unit="%"
              height={220}
              series={METRICS.map((m) => ({ key: m, label: t(`mon.metric.${m}`) }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('mon.resources')} />
          <CardContent>
            <DataTable
              data={srv}
              columns={srvColumns}
              getRowId={(s) => s.uuid}
              primaryColumnId="name"
              caption={t('mon.resources')}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('mon.uptime')} description={t('mon.uptimeHint')} />
          <CardContent>
            <DataTable
              data={checks}
              columns={upColumns}
              getRowId={(c) => c.uuid}
              primaryColumnId="site"
              caption={t('mon.uptime')}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
