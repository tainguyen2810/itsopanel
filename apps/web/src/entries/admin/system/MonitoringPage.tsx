import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Activity, BellRing, Globe, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { useSession } from '@/shared/session/SessionContext';
import { SectionNav } from '@/shared/page/SectionNav';
import { PageHeader } from '@/shared/page/PageHeader';
import { Alert as Callout } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { AreaChart } from '@/ui/Charts';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { ProgressBar } from '@/ui/ProgressBar';
import { Select } from '@/ui/Select';
import { StatCard } from '@/ui/StatCard';
import { RANGES, timeLabel, type Range } from '@/shared/monitoring/ranges';
import { get, list, type Row } from '../api';

export { RANGES, timeLabel, type Range };

type Srv = Row<'/api/v1/admin/servers'>;
type MetricKey =
  | 'cpu_pct'
  | 'ram_pct'
  | 'swap_pct'
  | 'disk_pct'
  | 'inode_pct'
  | 'io_read'
  | 'io_write'
  | 'net_in'
  | 'net_out'
  | 'load_1m'
  | 'tasks';
/** Nhóm biểu đồ (D-101): mỗi nhóm chung một đơn vị trục Y. */
const GROUPS = {
  usage: { metrics: ['cpu_pct', 'ram_pct', 'swap_pct'], unit: 'pct' },
  storage: { metrics: ['disk_pct', 'inode_pct'], unit: 'pct' },
  io: { metrics: ['io_read', 'io_write'], unit: 'bps' },
  network: { metrics: ['net_in', 'net_out'], unit: 'bps' },
  load: { metrics: ['load_1m'], unit: 'count' },
} satisfies Record<string, { metrics: MetricKey[]; unit: 'pct' | 'bps' | 'count' }>;
type Group = keyof typeof GROUPS;

export type MonSection = 'overview' | 'accounts' | 'uptime' | 'alerts' | 'channels' | 'deliveries';

export function MonitoringNav({ current }: { current: MonSection }) {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const sa = user.role === 'SUPER_ADMIN';
  const items: { key: MonSection; href: string; label: string }[] = [
    { key: 'overview', href: '/admin/monitoring', label: t('mon.nav.overview') },
    { key: 'accounts', href: '/admin/monitoring/accounts', label: t('mon.nav.accounts') },
    { key: 'uptime', href: '/admin/monitoring/uptime', label: t('mon.nav.uptime') },
    { key: 'alerts', href: '/admin/monitoring/alerts', label: t('mon.nav.alerts') },
    ...(sa
      ? ([
          { key: 'channels', href: '/admin/monitoring/channels', label: t('mon.nav.channels') },
          {
            key: 'deliveries',
            href: '/admin/monitoring/deliveries',
            label: t('mon.nav.deliveries'),
          },
        ] as const)
      : []),
  ];
  return <SectionNav label={t('mon.sections')} current={current} items={items} />;
}

const pct = (used: number, total: number) => (total > 0 ? (used * 100) / total : 0);

/** Nhãn trục thời gian theo khoảng: giờ:phút cho ≤ 24 giờ, ngày cho khoảng dài. */
export default function MonitoringPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [range, setRange] = useState<Range>('24h');
  const [group, setGroup] = useState<Group>('usage');
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
  const selected = srv.find((s) => s.uuid === current);
  const { metrics, unit } = GROUPS[group] as (typeof GROUPS)[Group];
  const series = useQueries({
    queries: metrics.map((metric) => ({
      queryKey: ['admin', 'metrics', current, metric, range],
      queryFn: () =>
        get('/api/v1/admin/metrics/servers/{id}', {
          path: { id: current ?? '' },
          query: { metric, range },
        }),
      enabled: current !== undefined,
    })),
  });
  // Byte/giây → KB/s để trục Y gọn.
  const scale = unit === 'bps' ? 1 / 1024 : 1;
  const byTime = new Map<string, Record<string, number | string>>();
  series.forEach((q, i) => {
    for (const [ts, v] of q.data?.points ?? []) {
      const row = byTime.get(ts) ?? { time: timeLabel(ts, range, fmt.date) };
      row[metrics[i] as string] = Math.round(v * scale * 10) / 10;
      byTime.set(ts, row);
    }
  });
  const rows = [...byTime.values()];
  const source = series[0]?.data?.source;
  const lastPoint = series[0]?.data?.points.at(-1)?.[0];
  const checks = uptime.data ?? [];
  const down = checks.filter((c) => c.state === 'down').length;
  const active = checks.filter((c) => c.enabled !== false);
  const avgUptime = active.length
    ? active.reduce((a, c) => a + c.uptime_30d, 0) / active.length
    : 0;
  const firing = (alerts.data ?? []).filter((a) => a.state === 'firing').length;
  const offline = srv.filter((s) => s.status !== 'ready');

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
  return (
    <>
      <PageHeader
        title={t('mon.title')}
        description={t('mon.description')}
        nav={<MonitoringNav current="overview" />}
      />
      <div className="flex flex-col gap-4">
        {offline.map((s) => (
          <Callout
            key={s.uuid}
            tone="danger"
            title={t('mon.offlineTitle', { name: s.name })}
            action={
              <AppLink href="/admin/monitoring/alerts" className="text-sm font-medium underline">
                {t('mon.viewAlerts')}
              </AppLink>
            }
          >
            {t('mon.offlineHint')}
          </Callout>
        ))}
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
            value={`${down}/${active.length}`}
          />
          <StatCard
            icon={Activity}
            tone="info"
            label={t('mon.avgUptime')}
            value={active.length ? fmt.pct(avgUptime, 2) : '—'}
          />
        </div>
        <Card>
          <CardHeader
            title={t('mon.chart')}
            description={
              source
                ? t(`mon.source.${source}`, { at: lastPoint ? fmt.dateTime(lastPoint) : '—' })
                : t('mon.chartHint')
            }
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
                  aria-label={t('mon.group')}
                  className="w-44"
                  value={group}
                  onValueChange={(v) => setGroup(v as Group)}
                  options={(Object.keys(GROUPS) as Group[]).map((g) => ({
                    value: g,
                    label: t(`mon.groups.${g}`),
                  }))}
                />
                <Select
                  aria-label={t('mon.range')}
                  className="w-32"
                  value={range}
                  onValueChange={(v) => setRange(v as Range)}
                  options={RANGES.map((r) => ({ value: r, label: t(`mon.ranges.${r}`) }))}
                />
              </div>
            }
          />
          <CardContent>
            {selected && selected.status !== 'ready' && (
              <p className="mb-2 text-sm text-danger-text">{t('mon.stale')}</p>
            )}
            {rows.length === 0 && series.every((q) => !q.isPending) ? (
              <p className="py-12 text-center text-sm text-muted">{t('mon.noData')}</p>
            ) : (
              <AreaChart
                ariaLabel={t('mon.chartAria', {
                  name: selected?.name ?? '',
                  what: t(`mon.groups.${group}`),
                })}
                data={rows}
                xKey="time"
                {...(unit === 'pct' ? { unit: '%' } : unit === 'bps' ? { unit: ' KB/s' } : {})}
                height={220}
                series={metrics.map((m) => ({ key: m, label: t(`mon.metric.${m}`) }))}
              />
            )}
          </CardContent>
        </Card>
        {current && <ServicesCard id={current} />}
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
      </div>
    </>
  );
}

/** Dịch vụ hệ thống của server đang chọn: chạy/dừng và chạy từ lúc nào. */
function ServicesCard({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'server', id, 'services'],
    queryFn: () => list('/api/v1/admin/servers/{id}/services', undefined, { path: { id } }),
  });
  const rows = q.data ?? [];
  return (
    <Card>
      <CardHeader title={t('mon.services')} description={t('mon.servicesHint')} />
      <CardContent>
        {q.isPending ? null : rows.length === 0 ? (
          <p className="text-sm text-muted">{t('mon.noServices')}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((sv) => (
              <li
                key={sv.name}
                className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{sv.name}</p>
                  <p className="text-xs text-muted">
                    {sv.since ? t('mon.since', { at: fmt.rel(sv.since) }) : '—'}
                  </p>
                </div>
                <StatusBadge status={sv.active ? 'running' : 'stopped'} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
