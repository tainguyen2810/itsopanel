import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { DetailPage } from '@/shared/page/DetailPage';
import { FormDialog } from '@/shared/page/FormDialog';
import { InfoList } from '@/shared/page/InfoList';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { useSession } from '@/shared/session/SessionContext';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { AreaChart } from '@/ui/Charts';
import { Checkbox, Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/DropdownMenu';
import { Gauge } from '@/ui/Gauge';
import { Label } from '@/ui/Label';
import { ProgressBar } from '@/ui/ProgressBar';
import { Select } from '@/ui/Select';
import { get, list, send, type Data, type Row } from '../api';
import { useAction } from '../useAction';
import { ServerNav, useServer } from './common';
import { pct } from './ServersPage';

type Server = Data<'/api/v1/admin/servers/{id}'>;
type Service = Row<'/api/v1/admin/servers/{id}/services'>;
type Account = Row<'/api/v1/admin/hosting-accounts'>;
const ROLES = ['web', 'db', 'backup', 'docker'] as const;

export default function ServerDetailPage() {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const server = useServer();
  const [editing, setEditing] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const reboot = useAction(
    () => send('POST', '/api/v1/admin/servers/{id}:reboot', { path: { id: server.id } }),
    {},
  );

  if (server.isPending) return <PageSkeleton />;
  if (server.isError) {
    return (
      <>
        <PageHeader title={t('servers.detail')} />
        <ErrorState error={server.error} onRetry={() => void server.refetch()} />
      </>
    );
  }
  const s = server.data;
  const sa = user.role === 'SUPER_ADMIN';
  return (
    <>
      <DetailPage
        nav={<ServerNav current="overview" />}
        title={s.name}
        meta={<StatusBadge status={s.agent_connected ? s.status : 'offline'} />}
        description={`${s.hostname} · ${s.os}`}
        actions={
          sa ? (
            <>
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                {t('servers.edit')}
              </Button>
              <Button variant="outline" onClick={() => setRebooting(true)}>
                <Power aria-hidden />
                {t('servers.reboot')}
              </Button>
            </>
          ) : undefined
        }
        tabs={[
          { value: 'overview', label: t('servers.tabs.overview'), content: <Overview s={s} /> },
          {
            value: 'services',
            label: t('servers.tabs.services'),
            content: <Services id={s.uuid} />,
          },
          { value: 'resources', label: t('servers.tabs.resources'), content: <Resources s={s} /> },
          {
            value: 'agent',
            label: t('servers.tabs.agent'),
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                <Agent s={s} />
                <Platform s={s} />
              </div>
            ),
          },
          {
            value: 'accounts',
            label: t('servers.tabs.accounts'),
            content: <Accounts id={s.uuid} />,
          },
        ]}
      />
      {sa && <EditServer s={s} open={editing} onOpenChange={setEditing} />}
      <ConfirmDialog
        open={rebooting}
        onOpenChange={setRebooting}
        title={t('servers.rebootTitle', { name: s.name })}
        description={t('servers.rebootHint', { count: s.account_count })}
        confirmName={s.name}
        confirmLabel={t('servers.reboot')}
        onConfirm={() => reboot.mutateAsync().then(() => setRebooting(false))}
      />
    </>
  );
}

function Overview({ s }: { s: Server }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const r = s.resources;
  const gauges: [string, number, string][] = [
    [t('dashboard.cpu'), r.cpu_pct, t('servers.cores', { count: r.cpu_cores })],
    [
      t('dashboard.ram'),
      pct(r.ram_used_mb, r.ram_mb),
      `${fmt.mb(r.ram_used_mb)} / ${fmt.mb(r.ram_mb)}`,
    ],
    [
      t('dashboard.disk'),
      pct(r.disk_used_mb, r.disk_mb),
      `${fmt.mb(r.disk_used_mb)} / ${fmt.mb(r.disk_mb)}`,
    ],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title={t('servers.resources')} />
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {gauges.map(([label, v, detail]) => (
            <Gauge
              key={label}
              label={label}
              value={v}
              detail={detail}
              thresholds={{ warn: 75, danger: 90 }}
            />
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title={t('servers.info')} />
        <CardContent>
          <InfoList
            items={[
              [
                t('servers.ip'),
                <span key="ip" className="font-mono text-sm">
                  {s.ip_addresses.join(', ')}
                </span>,
              ],
              [
                t('servers.roles'),
                <span key="r" className="flex flex-wrap gap-1">
                  {s.role_tags.map((x) => (
                    <Badge key={x} tone="neutral">
                      {t(`servers.role.${x}`)}
                    </Badge>
                  ))}
                </span>,
              ],
              [t('servers.kernel'), s.kernel],
              [t('servers.load'), fmt.num(r.load_1m)],
              [t('servers.uptime'), t('servers.days', { count: Math.floor(r.uptime_sec / 86400) })],
              [t('servers.accounts'), fmt.num(s.account_count)],
              [
                t('servers.accepting'),
                <StatusBadge key="a" status={s.accepting_new_accounts ? 'active' : 'disabled'} />,
              ],
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Services({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const control = useAction(
    (v: { service: string; action: string }) =>
      send('POST', '/api/v1/admin/servers/{id}/services/{service}:{action}', {
        path: { id, ...v },
      }),
    {},
  );
  const columns: ColumnDef<Service, unknown>[] = [
    {
      id: 'name',
      header: t('servers.service'),
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
    },
    { id: 'version', header: t('servers.version'), accessorFn: (x) => x.version ?? '—' },
    {
      id: 'state',
      header: t('servers.status'),
      accessorFn: (x) => (x.active ? 'running' : 'stopped'),
      cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
    },
    {
      id: 'enabled',
      header: t('servers.autostart'),
      accessorFn: (x) => (x.enabled ? t('servers.yes') : t('servers.no')),
    },
    {
      id: 'since',
      header: t('servers.since'),
      accessorFn: (x) => (x.since ? fmt.rel(x.since) : '—'),
    },
    {
      id: 'actions',
      header: t('servers.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={t('servers.serviceActions', { name: row.original.name })}
            >
              {t('servers.actions')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(row.original.active
              ? (['restart', 'reload', 'stop'] as const)
              : (['start'] as const)
            ).map((a) => (
              <DropdownMenuItem
                key={a}
                onSelect={() => control.mutate({ service: row.original.name, action: a })}
              >
                {t(`servers.serviceAction.${a}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];
  return (
    <ListPage<Service>
      embedded
      search={false}
      title={t('servers.tabs.services')}
      queryKey={['admin', 'server', id, 'services']}
      fetch={() => list('/api/v1/admin/servers/{id}/services', undefined, { path: { id } })}
      columns={columns}
      getRowId={(x) => x.name}
      primaryColumnId="name"
    />
  );
}

function Resources({ s }: { s: Server }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [range, setRange] = useState<'1h' | '24h' | '7d'>('24h');
  const metric = (m: string) =>
    get('/api/v1/admin/metrics/servers/{id}', {
      path: { id: s.uuid },
      query: { metric: m, range },
    });
  const q = useQuery({
    queryKey: ['admin', 'server', s.uuid, 'metrics', range],
    queryFn: async () => {
      const [cpu, ram] = await Promise.all([metric('cpu_pct'), metric('ram_pct')]);
      return cpu.points.map(([at, v], i) => ({
        at: range === '7d' ? fmt.date(at) : fmt.time(at),
        cpu: v,
        ram: ram.points[i]?.[1] ?? 0,
      }));
    },
  });
  const cap = useQuery({
    queryKey: ['admin', 'server', s.uuid, 'capacity'],
    queryFn: () => get('/api/v1/admin/servers/{id}/capacity', { path: { id: s.uuid } }),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader
          title={t('servers.usage')}
          action={
            <Select
              aria-label={t('dashboard.range')}
              className="w-32"
              value={range}
              onValueChange={(v) => setRange(v as typeof range)}
              options={(['1h', '24h', '7d'] as const).map((r) => ({
                value: r,
                label: t(`dashboard.ranges.${r}`),
              }))}
            />
          }
        />
        <CardContent>
          {q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <AreaChart
              ariaLabel={t('servers.usageAria', {
                name: s.name,
                range: t(`dashboard.ranges.${range}`),
              })}
              data={q.data ?? []}
              xKey="at"
              unit="%"
              series={[
                { key: 'cpu', label: t('dashboard.cpu') },
                { key: 'ram', label: t('dashboard.ram') },
              ]}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title={t('servers.capacity')} description={t('servers.capacityHint')} />
        <CardContent className="flex flex-col gap-4">
          {cap.data && (
            <>
              {(
                [
                  [
                    t('servers.allocCpu'),
                    cap.data.allocated_cpu_pct,
                    cap.data.cpu_cores * 100,
                    `${cap.data.allocated_cpu_pct}% / ${cap.data.cpu_cores * 100}%`,
                  ],
                  [
                    t('servers.allocRam'),
                    cap.data.allocated_ram_mb,
                    cap.data.ram_mb,
                    `${fmt.mb(cap.data.allocated_ram_mb)} / ${fmt.mb(cap.data.ram_mb)}`,
                  ],
                  [
                    t('servers.allocDisk'),
                    cap.data.allocated_disk_mb,
                    cap.data.disk_mb,
                    `${fmt.mb(cap.data.allocated_disk_mb)} / ${fmt.mb(cap.data.disk_mb)}`,
                  ],
                  [
                    t('servers.accounts'),
                    cap.data.account_count,
                    cap.data.max_accounts,
                    `${cap.data.account_count} / ${cap.data.max_accounts}`,
                  ],
                ] as const
              ).map(([label, used, total, text]) => (
                <div key={label} className="flex flex-col gap-1">
                  <div className="flex justify-between gap-2 text-sm">
                    <span>{label}</span>
                    <span className="text-muted tabular-nums">{text}</span>
                  </div>
                  <ProgressBar
                    label={label}
                    value={pct(used, total)}
                    thresholds={{ warn: 75, danger: 90 }}
                  />
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Agent({ s }: { s: Server }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  return (
    <Card>
      <CardHeader title={t('servers.agent')} description={t('servers.agentHint')} />
      <CardContent>
        <InfoList
          items={[
            [
              t('servers.connection'),
              <StatusBadge key="c" status={s.agent_connected ? 'connected' : 'disconnected'} />,
            ],
            [t('servers.agentVersion'), s.agent_version ?? '—'],
            [t('servers.specVersion'), String(s.spec_version)],
            [t('servers.observedVersion'), String(s.observed_version)],
            [
              t('servers.sync'),
              <StatusBadge
                key="d"
                status={
                  s.drift === null && s.spec_version === s.observed_version ? 'inSync' : 'drift'
                }
              />,
            ],
            [t('servers.observedAt'), fmt.opt(s.observed_at)],
            [t('servers.createdAt'), fmt.dateTime(s.created_at)],
          ]}
        />
      </CardContent>
    </Card>
  );
}

/** Sự thật nền tảng agent báo (system.info): quota, cgroup v2, systemd, kiến trúc, chế độ agent. */
export function Platform({ s }: { s: Server }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const p = s.platform;
  return (
    <Card>
      <CardHeader title={t('servers.platform.title')} description={t('servers.platform.hint')} />
      <CardContent>
        {p === null ? (
          <p className="text-base text-muted">{t('servers.platform.none')}</p>
        ) : (
          <InfoList
            items={[
              [
                t('servers.platform.quota'),
                <Badge key="q" tone={p.quota_mode === 'kernel' ? 'success' : 'warning'}>
                  {t(`servers.platform.quotaMode.${p.quota_mode}`)}
                </Badge>,
              ],
              [
                t('servers.platform.cgroup'),
                <Badge key="c" tone={p.cgroup_v2 ? 'success' : 'danger'}>
                  {p.cgroup_v2 ? t('servers.yes') : t('servers.no')}
                </Badge>,
              ],
              [
                t('servers.platform.systemd'),
                <Badge key="s" tone={p.systemd ? 'success' : 'danger'}>
                  {p.systemd ? t('servers.yes') : t('servers.no')}
                </Badge>,
              ],
              [t('servers.platform.arch'), p.arch || '—'],
              [
                t('servers.platform.mode'),
                <Badge key="m" tone={p.agent_mode === 'real' ? 'neutral' : 'warning'}>
                  {t(`servers.platform.agentMode.${p.agent_mode}`)}
                </Badge>,
              ],
              [t('servers.platform.factsAt'), fmt.opt(p.facts_at)],
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

function Accounts({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const columns: ColumnDef<Account, unknown>[] = [
    {
      id: 'username',
      header: t('servers.username'),
      accessorKey: 'username',
      cell: ({ row }) => (
        <AppLink
          href={`/admin/hosting-accounts/${row.original.uuid}`}
          className="font-medium hover:underline"
        >
          {row.original.username}
        </AppLink>
      ),
    },
    { id: 'owner', header: t('servers.owner'), accessorFn: (a) => a.owner.name },
    { id: 'package', header: t('servers.package'), accessorFn: (a) => a.package.name },
    {
      id: 'state',
      header: t('servers.status'),
      accessorKey: 'lifecycle_state',
      cell: ({ row }) => <StatusBadge status={row.original.lifecycle_state} />,
    },
  ];
  return (
    <ListPage<Account>
      embedded
      title={t('servers.tabs.accounts')}
      queryKey={['admin', 'server', id, 'accounts']}
      fetch={(q) =>
        list('/api/v1/admin/hosting-accounts', { ...q, filters: { ...q.filters, server: id } })
      }
      columns={columns}
      getRowId={(a) => a.uuid}
      primaryColumnId="username"
    />
  );
}

function EditServer({
  s,
  open,
  onOpenChange,
}: {
  s: Server;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const [roles, setRoles] = useState<string[]>(s.role_tags);
  const [accepting, setAccepting] = useState(s.accepting_new_accounts);
  const save = useAction(
    () =>
      send('PATCH', '/api/v1/admin/servers/{id}', {
        path: { id: s.uuid },
        body: { role_tags: roles, accepting_new_accounts: accepting },
      }),
    {
      success: t('servers.saved'),
      invalidate: [
        ['admin', 'server', s.uuid],
        ['admin', 'servers'],
      ],
      onSuccess: () => onOpenChange(false),
    },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('servers.editTitle', { name: s.name })}
      pending={save.isPending}
      onSubmit={() => save.mutate()}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">{t('servers.roles')}</legend>
        <div className="flex flex-wrap gap-4">
          {ROLES.map((r) => (
            <label key={r} className="flex items-center gap-2 text-base">
              <Checkbox
                checked={roles.includes(r)}
                onCheckedChange={(c) =>
                  setRoles(c === true ? [...roles, r] : roles.filter((x) => x !== r))
                }
              />
              {t(`servers.role.${r}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="accepting">{t('servers.accepting')}</Label>
        <Switch id="accepting" checked={accepting} onCheckedChange={setAccepting} />
      </div>
    </FormDialog>
  );
}
