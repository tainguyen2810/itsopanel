import { useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Boxes,
  Database,
  Globe,
  RefreshCw,
  Server,
  ShieldAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState } from '@/shared/page/states';
import { useSession } from '@/shared/session/SessionContext';
import { AppLink } from '@/ui/AppLink';
import { SeverityBadge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { AreaChart, BarChart, DonutChart } from '@/ui/Charts';
import { Skeleton } from '@/ui/Feedback';
import { Gauge } from '@/ui/Gauge';
import { ProgressBar } from '@/ui/ProgressBar';
import { Select } from '@/ui/Select';
import { StatCard } from '@/ui/StatCard';
import { get, list } from '../api';
import { auditLabel } from '../labels';
import { SystemStatusCard } from './SystemStatusCard';

type Range = '1h' | '24h' | '7d';
const NET_CAPACITY = 125_000_000; // 1 Gbps mỗi server (byte/giây)

function ViewAll({ href }: { href: string }) {
  const { t } = useTranslation('common');
  return (
    <AppLink
      href={href}
      className="inline-flex shrink-0 items-center gap-1 text-sm text-primary-text hover:underline"
    >
      {t('actions.viewAll')}
      <ArrowRight aria-hidden className="size-3.5" />
    </AppLink>
  );
}

function StatLink({
  href,
  ...card
}: {
  href: string;
  label: string;
  value: string;
  icon: LucideIcon;
  tone: 'primary' | 'info' | 'accent' | 'success' | 'warning';
  hint?: string;
}) {
  return (
    <AppLink
      href={href}
      className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&>*]:h-full [&>*]:hover:border-border-strong"
    >
      <StatCard {...card} />
    </AppLink>
  );
}

/** Bảng điều khiển theo mockup: số liệu lấy từ API (khớp các trang danh sách). */
export default function DashboardPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { user } = useSession();
  const qc = useQueryClient();
  const [range, setRange] = useState<Range>('24h');
  const [today] = useState(() => Date.now());

  const summary = useQuery({
    queryKey: ['admin', 'dashboard'],
    queryFn: () => get('/api/v1/admin/dashboard/summary'),
    refetchInterval: 30_000, // D-106: dashboard poll 30 giây (không WebSocket)
  });
  const servers = useQuery({
    queryKey: ['admin', 'servers', 'all'],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const websites = useQuery({
    queryKey: ['admin', 'websites', 'all'],
    queryFn: () => list('/api/v1/admin/websites'),
  });
  const packages = useQuery({
    queryKey: ['admin', 'packages', 'all'],
    queryFn: () => list('/api/v1/admin/hosting-packages'),
    enabled: user.role === 'SUPER_ADMIN',
  });
  const activity = useQuery({
    queryKey: ['admin', 'audit', 'recent'],
    queryFn: () => get('/api/v1/admin/audit-logs', { query: { limit: 5, sort: '-at' } }),
  });
  const events = useQuery({
    queryKey: ['admin', 'security-events', 'recent'],
    queryFn: () => get('/api/v1/admin/security/events', { query: { limit: 3, sort: '-at' } }),
  });
  const serverIds = (servers.data ?? []).map((s) => s.uuid);
  const net = useQueries({
    queries: serverIds.flatMap((id) =>
      (['net_in', 'net_out'] as const).map((metric) => ({
        queryKey: ['admin', 'metrics', id, metric, range],
        queryFn: () =>
          get('/api/v1/admin/metrics/servers/{id}', { path: { id }, query: { metric, range } }),
      })),
    ),
  });

  const s = summary.data;
  const srv = servers.data ?? [];
  const online = srv.filter((x) => x.status === 'ready').length;

  // Tài nguyên tổng của các server trong phạm vi.
  const cores = srv.reduce((a, x) => a + x.resources.cpu_cores, 0);
  const coresUsed = srv.reduce(
    (a, x) => a + (x.resources.cpu_cores * x.resources.cpu_pct) / 100,
    0,
  );
  const ram = srv.reduce((a, x) => a + x.resources.ram_mb, 0);
  const ramUsed = srv.reduce((a, x) => a + x.resources.ram_used_mb, 0);
  const disk = srv.reduce((a, x) => a + x.resources.disk_mb, 0);
  const diskUsed = srv.reduce((a, x) => a + x.resources.disk_used_mb, 0);

  // Lưu lượng mạng: cộng các server theo từng mốc thời gian.
  const byTime = new Map<string, { time: string; in: number; out: number }>();
  net.forEach((q, i) => {
    const key = i % 2 === 0 ? 'in' : 'out';
    for (const [ts, v] of q.data?.points ?? []) {
      const row = byTime.get(ts) ?? { time: ts, in: 0, out: 0 };
      row[key] += (v * 8) / 1_000_000; // Mbps
      byTime.set(ts, row);
    }
  });
  const netRows = [...byTime.values()].map((r) => ({
    time: range === '7d' ? fmt.date(r.time) : r.time.slice(11, 16),
    in: Math.round(r.in),
    out: Math.round(r.out),
  }));
  const lastNet = netRows.at(-1);
  const netNow = lastNet ? ((lastNet.in + lastNet.out) * 1_000_000) / 8 : 0;
  const netCap = NET_CAPACITY * Math.max(1, srv.length);

  // Số website tạo theo ngày (7 ngày gần nhất, cộng dồn).
  const sites = websites.data ?? [];
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today - (6 - i) * 86_400_000);
    return d.toISOString().slice(0, 10);
  });
  const siteRows = days.map((d) => ({
    day: `${d.slice(8, 10)}/${d.slice(5, 7)}`,
    sites: sites.filter((w) => w.created_at.slice(0, 10) <= d).length,
  }));

  const pkgName = new Map((packages.data ?? []).map((p) => [p.code, p.name]));
  const dist = (s?.package_distribution ?? []).filter((p) => p.accounts > 0);
  const distTotal = dist.reduce((a, p) => a + p.accounts, 0);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin'] });

  return (
    <>
      <PageHeader
        title={t('dashboard.welcome', { name: user.name })}
        crumb={t('dashboard.title')}
        description={t('dashboard.subtitle')}
        actions={
          <div className="flex items-center gap-2">
            {s && (
              <span className="hidden text-sm text-muted sm:inline">
                {t('dashboard.updated', { time: fmt.dateTime(s.updated_at) })}
              </span>
            )}
            <Button
              variant="outline"
              size="icon"
              onClick={refresh}
              aria-label={t('dashboard.refresh')}
            >
              <RefreshCw aria-hidden />
            </Button>
            <Select
              aria-label={t('dashboard.range')}
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

      {summary.isError && (
        <div className="mb-4">
          <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        {summary.isError ? null : s === undefined ? (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-22" />)
        ) : (
          <>
            <StatLink
              href="/admin/servers"
              label={t('dashboard.stats.servers')}
              value={fmt.num(s.counts.servers ?? 0)}
              icon={Server}
              tone="success"
              hint={t('dashboard.stats.online', { count: online })}
            />
            <StatLink
              href="/admin/websites"
              label={t('dashboard.stats.websites')}
              value={fmt.num(s.counts.websites ?? 0)}
              icon={Globe}
              tone="info"
            />
            <StatLink
              href="/admin/databases"
              label={t('dashboard.stats.databases')}
              value={fmt.num(s.counts.databases ?? 0)}
              icon={Database}
              tone="accent"
            />
            <StatLink
              href="/admin/hosting-accounts"
              label={t('dashboard.stats.accounts')}
              value={fmt.num(s.counts.hosting_accounts ?? 0)}
              icon={Boxes}
              tone="primary"
              hint={t('dashboard.stats.jobsRunning', { count: s.jobs_running })}
            />
            {user.role === 'SUPER_ADMIN' ? (
              <StatLink
                href="/admin/users"
                label={t('dashboard.stats.users')}
                value={fmt.num(s.counts.users ?? 0)}
                icon={Users}
                tone="warning"
                hint={t('dashboard.stats.packages', { count: s.counts.packages ?? 0 })}
              />
            ) : (
              <StatLink
                href="/admin/security"
                label={t('dashboard.stats.securityEvents')}
                value={fmt.num(s.security_events_24h)}
                icon={ShieldAlert}
                tone="warning"
              />
            )}
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader
            title={t('dashboard.resources')}
            description={t('dashboard.resourcesHint', { count: srv.length })}
          />
          <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {servers.isPending ? (
              Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="mx-auto size-28 rounded-full" />
              ))
            ) : (
              <>
                <Gauge
                  label={t('dashboard.cpu')}
                  value={cores ? (coresUsed * 100) / cores : 0}
                  detail={t('dashboard.vcpu', { used: fmt.num(coresUsed), total: fmt.num(cores) })}
                  tone="success"
                  thresholds={{ warn: 75, danger: 90 }}
                />
                <Gauge
                  label={t('dashboard.ram')}
                  value={ram ? (ramUsed * 100) / ram : 0}
                  detail={`${fmt.mb(ramUsed)} / ${fmt.mb(ram)}`}
                  tone="primary"
                  thresholds={{ warn: 80, danger: 92 }}
                />
                <Gauge
                  label={t('dashboard.disk')}
                  value={disk ? (diskUsed * 100) / disk : 0}
                  detail={`${fmt.mb(diskUsed)} / ${fmt.mb(disk)}`}
                  tone="accent"
                  thresholds={{ warn: 80, danger: 90 }}
                />
                <Gauge
                  label={t('dashboard.bandwidth')}
                  value={(netNow * 100) / netCap}
                  detail={t('dashboard.gbps', {
                    used: fmt.num((netNow * 8) / 1e9, 2),
                    total: fmt.num((netCap * 8) / 1e9),
                  })}
                  tone="info"
                />
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('dashboard.network')} description={t(`dashboard.ranges.${range}`)} />
          <CardContent>
            {netRows.length === 0 ? (
              <Skeleton className="h-52" />
            ) : (
              <AreaChart
                ariaLabel={t('dashboard.networkAria', { range: t(`dashboard.ranges.${range}`) })}
                data={netRows}
                xKey="time"
                unit=" Mbps"
                height={208}
                series={[
                  { key: 'in', label: t('dashboard.download') },
                  { key: 'out', label: t('dashboard.upload') },
                ]}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader
            title={t('dashboard.serverList')}
            action={<ViewAll href="/admin/servers" />}
          />
          <CardContent className="flex flex-col divide-y divide-border p-0">
            {servers.isPending && <Skeleton className="m-5 h-32" />}
            {srv.map((x) => {
              const sv = s?.servers.find((y) => y.server.uuid === x.uuid);
              return (
                <div
                  key={x.uuid}
                  className="grid gap-3 px-5 py-3 sm:grid-cols-[1.4fr_2fr_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <AppLink
                      href={`/admin/servers/${x.uuid}`}
                      className="font-medium hover:underline"
                    >
                      {x.name}
                    </AppLink>
                    <p className="truncate text-sm text-muted">
                      {x.ip_addresses.at(-1)} · {x.role_tags.join(', ')}
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    {(
                      [
                        ['cpu', sv?.cpu_pct ?? x.resources.cpu_pct],
                        ['ram', sv?.ram_pct ?? 0],
                        ['disk', sv?.disk_pct ?? 0],
                      ] as const
                    ).map(([k, v]) => (
                      <div key={k} className="min-w-0">
                        <p className="text-xs text-muted tabular-nums">
                          {t(`dashboard.${k}`)} {fmt.pct(v)}
                        </p>
                        <ProgressBar
                          label={`${x.name} ${t(`dashboard.${k}`)}`}
                          value={v}
                          thresholds={{ warn: 75, danger: 90 }}
                        />
                      </div>
                    ))}
                  </div>
                  <StatusBadge status={x.status} />
                </div>
              );
            })}
          </CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader
            title={t('dashboard.activity')}
            action={<ViewAll href="/admin/audit-logs" />}
          />
          <CardContent>
            {activity.isPending ? (
              <Skeleton className="h-40" />
            ) : (
              <ul className="flex flex-col gap-3">
                {(activity.data ?? []).map((a) => (
                  <li key={a.uuid} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{auditLabel(t, a.action)}</p>
                      <p className="truncate text-sm text-muted">
                        {a.actor?.name ?? t('dashboard.system')}
                        {a.server ? ` · ${a.server.name}` : ''}
                      </p>
                    </div>
                    <time
                      dateTime={a.at}
                      className="shrink-0 text-xs text-muted"
                      title={fmt.dateTime(a.at)}
                    >
                      {fmt.rel(a.at)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader
            title={t('dashboard.websiteCount')}
            description={t('dashboard.websiteTotal', { count: sites.length })}
          />
          <CardContent>
            <BarChart
              ariaLabel={t('dashboard.websiteAria', { count: sites.length })}
              data={siteRows}
              xKey="day"
              height={200}
              series={[{ key: 'sites', label: t('dashboard.stats.websites') }]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('dashboard.packageDist')} />
          <CardContent>
            {s === undefined ? (
              <Skeleton className="h-48" />
            ) : (
              <DonutChart
                ariaLabel={t('dashboard.packageAria', { count: distTotal })}
                data={dist.map((p) => ({
                  label: pkgName.get(p.code) ?? p.code,
                  value: p.accounts,
                }))}
                centerLabel={{ value: fmt.num(distTotal), caption: t('dashboard.accountsCaption') }}
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader
            title={t('dashboard.securityAlerts')}
            action={<ViewAll href="/admin/security" />}
          />
          <CardContent>
            {events.isPending ? (
              <Skeleton className="h-40" />
            ) : (
              <ul className="flex flex-col gap-3">
                {(events.data ?? []).map((e) => (
                  <li key={e.uuid} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{e.message}</p>
                      <p className="truncate text-sm text-muted">
                        {e.source_ip ?? ''} {e.website ? `· ${e.website.primary_domain}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <SeverityBadge severity={e.severity} />
                      <time dateTime={e.at} className="text-xs text-muted">
                        {fmt.rel(e.at)}
                      </time>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader
            title={t('dashboard.monAlerts')}
            action={<ViewAll href="/admin/monitoring/alerts" />}
          />
          <CardContent>
            {s === undefined ? (
              <Skeleton className="h-40" />
            ) : (s.alerts_recent ?? []).length === 0 ? (
              <p className="text-sm text-muted">{t('dashboard.monAlertsNone')}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {(s.alerts_recent ?? []).map((a) => (
                  <li key={a.uuid} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{a.message ?? a.rule.name}</p>
                      <p className="truncate text-sm text-muted">
                        {a.rule.name}
                        {a.server ? ` · ${a.server.name}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusBadge status={a.state} />
                      <time dateTime={a.started_at} className="text-xs text-muted">
                        {fmt.rel(a.started_at)}
                      </time>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <SystemStatusCard />
    </>
  );
}
