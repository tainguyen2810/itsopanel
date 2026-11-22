import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { get, list, send, type Row } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { useFmt } from '@/shared/format/useFmt';
import { RANGES, timeLabel, type Range } from '@/shared/monitoring/ranges';
import { certDays, UptimeResults } from '@/shared/monitoring/UptimeResults';
import { PageHeader } from '@/shared/page/PageHeader';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { AreaChart } from '@/ui/Charts';
import { Switch } from '@/ui/Checkbox';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { Select } from '@/ui/Select';

type Check = Row<'/hosting-accounts/{id}/uptime'>;
const METRICS = ['cpu_pct', 'ram_pct', 'disk_pct'] as const;

/**
 * Giám sát (Portal, D-101/D-105): tài nguyên account của mình theo thời gian và uptime website của mình.
 * USER chỉ bật/tắt kiểm tra; tạo/xóa và ngưỡng cảnh báo do quản trị.
 */
export default function MonitoringPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const accounts = useQuery({
    queryKey: ['portal', 'accounts'],
    queryFn: () => list('/hosting-accounts'),
  });
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [range, setRange] = useState<Range>('24h');
  const [viewing, setViewing] = useState<Check | null>(null);
  const accs = accounts.data ?? [];
  const id = picked ?? accs[0]?.uuid;
  const series = useQueries({
    queries: METRICS.map((metric) => ({
      queryKey: ['portal', 'usage-history', id, metric, range],
      queryFn: () =>
        get('/hosting-accounts/{id}/usage-history', {
          path: { id: id ?? '' },
          query: { metric, range },
        }),
      enabled: id !== undefined,
    })),
  });
  const checks = useQuery({
    queryKey: ['portal', 'uptime', id],
    queryFn: () => get('/hosting-accounts/{id}/uptime', { path: { id: id ?? '' } }),
    enabled: id !== undefined,
  });
  const toggle = useAction(
    (c: Check) =>
      send('PATCH', '/websites/{id}/uptime', {
        path: { id: c.website.uuid },
        body: { enabled: c.enabled === false },
      }),
    { invalidate: [['portal', 'uptime']] },
  );
  const byTime = new Map<string, Record<string, number | string>>();
  series.forEach((q, i) => {
    for (const [ts, v] of q.data?.points ?? []) {
      const row = byTime.get(ts) ?? { time: timeLabel(ts, range, fmt.date) };
      row[METRICS[i] as string] = v;
      byTime.set(ts, row);
    }
  });
  const source = series[0]?.data?.source;
  const lastAt = series[0]?.data?.points.at(-1)?.[0];
  const columns: ColumnDef<Check, unknown>[] = [
    {
      id: 'site',
      header: t('sites.domain'),
      accessorFn: (c) => c.website.primary_domain,
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium break-all">{row.original.website.primary_domain}</p>
          <p className="text-sm break-all text-muted">{row.original.path ?? '/'}</p>
        </div>
      ),
    },
    {
      id: 'state',
      header: t('sites.status'),
      accessorFn: (c) => c.state ?? '',
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge status={row.original.state ?? 'unknown'} />
          {row.original.state === 'down' && (
            <span className="text-xs text-danger-text">
              {row.original.last_error ?? row.original.last_status}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'uptime',
      header: t('uptime.ratio'),
      accessorKey: 'uptime_30d',
      cell: ({ row }) => (
        <span className="text-sm tabular-nums">
          {t('uptime.window.2')} {fmt.pct(row.original.uptime_30d, 2)}
        </span>
      ),
    },
    {
      id: 'cert',
      header: t('uptime.cert'),
      accessorFn: (c) => c.cert_expires_at ?? '',
      cell: ({ row }) => {
        const d = certDays(row.original.cert_expires_at);
        return d === null ? (
          '—'
        ) : (
          <Badge tone={d <= 7 ? 'danger' : d <= 14 ? 'warning' : 'neutral'}>
            {t('uptime.daysLeft', { count: d })}
          </Badge>
        );
      },
    },
    {
      id: 'enabled',
      header: t('alerts.enabled'),
      accessorFn: (c) => (c.enabled === false ? 0 : 1),
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled !== false}
          disabled={toggle.isPending}
          onCheckedChange={() => toggle.mutate(row.original)}
          aria-label={t('uptime.toggle', { name: row.original.website.primary_domain })}
        />
      ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => setViewing(row.original)}>
          {t('uptime.results')}
        </Button>
      ),
    },
  ];
  const accName = accs.find((a) => a.uuid === id)?.username ?? '';
  return (
    <>
      <PageHeader
        title={t('pmon.title')}
        description={t('pmon.description')}
        actions={
          accs.length > 1 ? (
            <Select
              aria-label={t('pmon.account')}
              className="w-44"
              value={id ?? ''}
              onValueChange={setPicked}
              options={accs.map((a) => ({ value: a.uuid, label: a.username }))}
            />
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title={t('pmon.usage')}
            description={
              source && lastAt
                ? t(`mon.source.${source}`, { at: fmt.rel(lastAt) })
                : t('pmon.usageHint')
            }
            action={
              <Select
                aria-label={t('mon.range')}
                className="w-32"
                value={range}
                onValueChange={(v) => setRange(v as Range)}
                options={RANGES.map((r) => ({ value: r, label: t(`mon.ranges.${r}`) }))}
              />
            }
          />
          <CardContent>
            <AreaChart
              ariaLabel={t('accUsage.chartFor', { name: accName })}
              data={[...byTime.values()]}
              xKey="time"
              unit="%"
              height={240}
              series={METRICS.map((m) => ({ key: m, label: t(`accUsage.metric.${m}`) }))}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('uptime.title')} description={t('pmon.uptimeHint')} />
          <CardContent>
            <DataTable
              data={checks.data ?? []}
              columns={columns}
              getRowId={(c) => c.uuid}
              primaryColumnId="site"
              caption={t('uptime.title')}
              empty={t('pmon.noChecks')}
            />
          </CardContent>
        </Card>
      </div>
      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        {viewing && <ResultsDialog check={viewing} />}
      </Dialog>
    </>
  );
}

function ResultsDialog({ check }: { check: Check }) {
  const { t } = useTranslation('admin');
  const results = useQuery({
    queryKey: ['portal', 'uptime', check.website.uuid, 'results'],
    queryFn: () => get('/websites/{id}/uptime/results', { path: { id: check.website.uuid } }),
  });
  return (
    <DialogContent
      title={t('uptime.resultsTitle', { name: check.website.primary_domain })}
      className="max-w-2xl"
    >
      <UptimeResults check={check} results={results.data ?? []} />
    </DialogContent>
  );
}
