import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { LineChart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { PageHeader } from '@/shared/page/PageHeader';
import { AppLink } from '@/ui/AppLink';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { AreaChart } from '@/ui/Charts';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Drawer, DrawerContent } from '@/ui/Dialog';
import { ProgressBar } from '@/ui/ProgressBar';
import { Select } from '@/ui/Select';
import { get, list, type Row } from '../api';
import { MonitoringNav, RANGES, timeLabel, type Range } from './MonitoringPage';

type Usage = Row<'/api/v1/admin/metrics/servers/{id}/accounts'>;
const ACC_METRICS = ['cpu_pct', 'ram_pct', 'disk_pct'] as const;

const pct = (used: number, limit: number | null) =>
  limit && limit > 0 ? Math.min(100, (used * 100) / limit) : 0;

/** Số liệu cgroup theo account (D-101): bảng top account trên server + biểu đồ từng account. */
export default function AccountsMonitorPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const servers = useQuery({
    queryKey: ['admin', 'servers'],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const [serverId, setServerId] = useState<string | undefined>(undefined);
  const [open, setOpen] = useState<Usage | null>(null);
  const srv = servers.data ?? [];
  // Mặc định máy chủ đang online đầu tiên (máy offline không có mẫu mới).
  const current = serverId ?? (srv.find((s) => s.status === 'ready') ?? srv[0])?.uuid;
  const usage = useQuery({
    queryKey: ['admin', 'account-usage', current],
    queryFn: () =>
      get('/api/v1/admin/metrics/servers/{id}/accounts', {
        path: { id: current ?? '' },
        query: { limit: 200 },
      }),
    enabled: current !== undefined,
  });
  const kbs = (bps: number) => `${fmt.num(bps / 1024, 1)} KB/s`;
  const columns: ColumnDef<Usage, unknown>[] = [
    {
      id: 'account',
      header: t('accUsage.account'),
      accessorFn: (r) => r.hosting_account.username,
      cell: ({ row }) => (
        <AppLink
          href={`/admin/hosting-accounts/${row.original.hosting_account.uuid}`}
          className="font-medium hover:underline"
        >
          {row.original.hosting_account.username}
        </AppLink>
      ),
    },
    {
      id: 'cpu',
      header: t('accUsage.cpu'),
      accessorKey: 'cpu_pct',
      cell: ({ row }) => <span className="tabular-nums">{fmt.pct(row.original.cpu_pct, 1)}</span>,
    },
    {
      id: 'ram',
      header: t('accUsage.ram'),
      accessorKey: 'ram_mb',
      cell: ({ row }) => (
        <div className="flex min-w-36 flex-col gap-1">
          <ProgressBar
            value={pct(row.original.ram_mb, row.original.ram_limit_mb)}
            label={t('accUsage.ramOf', { name: row.original.hosting_account.username })}
            thresholds={{ warn: 80, danger: 95 }}
          />
          <span className="text-xs text-muted tabular-nums">
            {fmt.mb(row.original.ram_mb)}
            {row.original.ram_limit_mb ? ` / ${fmt.mb(row.original.ram_limit_mb)}` : ''}
          </span>
        </div>
      ),
    },
    {
      id: 'io',
      header: t('accUsage.io'),
      accessorKey: 'io_write_bps',
      cell: ({ row }) => (
        <span className="flex flex-col text-sm tabular-nums">
          <span>{t('accUsage.read', { v: kbs(row.original.io_read_bps) })}</span>
          <span>{t('accUsage.write', { v: kbs(row.original.io_write_bps) })}</span>
        </span>
      ),
    },
    {
      id: 'tasks',
      header: t('accUsage.tasks'),
      accessorKey: 'tasks',
      cell: ({ row }) => <span className="tabular-nums">{fmt.num(row.original.tasks)}</span>,
    },
    {
      id: 'disk',
      header: t('accUsage.disk'),
      accessorKey: 'disk_mb',
      cell: ({ row }) => (
        <div className="flex min-w-36 flex-col gap-1">
          <ProgressBar
            value={pct(row.original.disk_mb, row.original.disk_limit_mb)}
            label={t('accUsage.diskOf', { name: row.original.hosting_account.username })}
            thresholds={{ warn: 80, danger: 95 }}
          />
          <span className="text-xs text-muted tabular-nums">
            {fmt.mb(row.original.disk_mb)}
            {row.original.disk_limit_mb ? ` / ${fmt.mb(row.original.disk_limit_mb)}` : ''}
          </span>
        </div>
      ),
    },
    {
      id: 'chart',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(row.original)}
          aria-label={t('accUsage.chartFor', { name: row.original.hosting_account.username })}
        >
          <LineChart aria-hidden />
          {t('accUsage.chart')}
        </Button>
      ),
    },
  ];
  const sampled = usage.data?.[0]?.sampled_at;
  return (
    <>
      <PageHeader
        title={t('accUsage.title')}
        description={t('accUsage.description')}
        nav={<MonitoringNav current="accounts" />}
      />
      <Card>
        <CardHeader
          title={t('accUsage.top')}
          description={sampled ? t('accUsage.sampled', { at: fmt.dateTime(sampled) }) : undefined}
          action={
            <Select
              aria-label={t('mon.server')}
              className="w-40"
              value={current ?? ''}
              onValueChange={setServerId}
              options={srv.map((s) => ({ value: s.uuid, label: s.name }))}
            />
          }
        />
        <CardContent>
          <DataTable
            data={usage.data ?? []}
            columns={columns}
            getRowId={(r) => r.hosting_account.uuid}
            primaryColumnId="account"
            caption={t('accUsage.top')}
            empty={t('accUsage.none')}
          />
        </CardContent>
      </Card>
      <Drawer open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        {open && <AccountCharts usage={open} />}
      </Drawer>
    </>
  );
}

function AccountCharts({ usage }: { usage: Usage }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [range, setRange] = useState<Range>('24h');
  const id = usage.hosting_account.uuid;
  const series = useQueries({
    queries: ACC_METRICS.map((metric) => ({
      queryKey: ['admin', 'account-metrics', id, metric, range],
      queryFn: () =>
        get('/api/v1/admin/metrics/hosting-accounts/{id}', {
          path: { id },
          query: { metric, range },
        }),
    })),
  });
  const byTime = new Map<string, Record<string, number | string>>();
  series.forEach((q, i) => {
    for (const [ts, v] of q.data?.points ?? []) {
      const row = byTime.get(ts) ?? { time: timeLabel(ts, range, fmt.date) };
      row[ACC_METRICS[i] as string] = v;
      byTime.set(ts, row);
    }
  });
  return (
    <DrawerContent
      title={usage.hosting_account.username}
      description={t('accUsage.chartHint')}
      className="w-[min(36rem,calc(100vw-3rem))]"
    >
      <div className="flex flex-col gap-3 p-5">
        <Select
          aria-label={t('mon.range')}
          className="w-36"
          value={range}
          onValueChange={(v) => setRange(v as Range)}
          options={RANGES.map((r) => ({ value: r, label: t(`mon.ranges.${r}`) }))}
        />
        <AreaChart
          ariaLabel={t('accUsage.chartFor', { name: usage.hosting_account.username })}
          data={[...byTime.values()]}
          xKey="time"
          unit="%"
          height={240}
          series={ACC_METRICS.map((m) => ({ key: m, label: t(`accUsage.metric.${m}`) }))}
        />
      </div>
    </DrawerContent>
  );
}
