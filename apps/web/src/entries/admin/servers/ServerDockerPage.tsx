import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Boxes, RefreshCw, ScrollText, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { DetailPage } from '@/shared/page/DetailPage';
import { InfoList } from '@/shared/page/InfoList';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { Skeleton } from '@/ui/Feedback';
import { get, list, send, type Data, type Row } from '../api';
import { useAction } from '../useAction';
import { ServerNav, useServer } from './common';

type Host = Data<'/api/v1/admin/servers/{id}/docker'>;
type Container = Row<'/api/v1/admin/servers/{id}/docker/containers'>;
type Image = Row<'/api/v1/admin/servers/{id}/docker/images'>;
type Volume = Row<'/api/v1/admin/servers/{id}/docker/volumes'>;
type Network = Row<'/api/v1/admin/servers/{id}/docker/networks'>;

export default function ServerDockerPage() {
  const { t } = useTranslation('admin');
  const server = useServer();
  const q = useQuery({
    queryKey: ['admin', 'server', server.id, 'docker'],
    queryFn: () => get('/api/v1/admin/servers/{id}/docker', { path: { id: server.id } }),
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <>
        <PageHeader nav={<ServerNav current="docker" />} title={t('docker.title')} />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const host = q.data;
  if (host.state === 'not_installed' || host.state === 'installing') {
    return (
      <>
        <PageHeader
          nav={<ServerNav current="docker" />}
          title={t('docker.title')}
          description={t('docker.description')}
        />
        <EnableDocker id={server.id} host={host} />
      </>
    );
  }
  return (
    <DetailPage
      nav={<ServerNav current="docker" />}
      title={t('docker.title')}
      meta={<StatusBadge status={host.state} />}
      description={t('docker.versionLine', {
        engine: host.engine_version ?? '—',
        compose: host.compose_version ?? '—',
      })}
      tabs={[
        {
          value: 'overview',
          label: t('servers.tabs.overview'),
          content: <Overview id={server.id} host={host} />,
        },
        {
          value: 'containers',
          label: t('docker.containersCount', { count: host.counts.containers }),
          content: <Containers id={server.id} />,
        },
        { value: 'images', label: t('docker.images'), content: <Images id={server.id} /> },
        { value: 'volumes', label: t('docker.volumes'), content: <Volumes id={server.id} /> },
        { value: 'networks', label: t('docker.networks'), content: <Networks id={server.id} /> },
      ]}
    />
  );
}

function EnableDocker({ id, host }: { id: string; host: Host }) {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const [open, setOpen] = useState(false);
  const enable = useAction(
    () => send('POST', '/api/v1/admin/servers/{id}/docker:enable', { path: { id } }),
    { invalidate: [['admin', 'server', id]], onSuccess: () => setOpen(false) },
  );
  const installing = host.state === 'installing';
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Boxes aria-hidden className="size-4" />
            {installing ? t('docker.enable.installing') : t('docker.enable.title')}
          </span>
        }
        description={t('docker.enable.description')}
      />
      <CardContent className="flex flex-col gap-4">
        <ul className="flex list-disc flex-col gap-1 pl-5 text-base">
          {(['package', 'bind', 'chain', 'group', 'limits'] as const).map((k) => (
            <li key={k}>{t(`docker.enable.steps.${k}`)}</li>
          ))}
        </ul>
        <Alert tone="info" title={t('docker.enable.userNote')} />
        {user.role === 'SUPER_ADMIN' ? (
          <div>
            <Button onClick={() => setOpen(true)} disabled={installing}>
              {installing ? t('docker.enable.installing') : t('docker.enable.action')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted">{t('docker.enable.saOnly')}</p>
        )}
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="primary"
        title={t('docker.enable.confirm')}
        description={t('docker.enable.confirmHint')}
        confirmLabel={t('docker.enable.action')}
        onConfirm={() => enable.mutateAsync().then(() => undefined)}
      />
    </Card>
  );
}

function Overview({ id, host }: { id: string; host: Host }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const sync = useAction(
    () => send('POST', '/api/v1/admin/servers/{id}/docker:sync-firewall', { path: { id } }),
    { invalidate: [['admin', 'server', id, 'docker']] },
  );
  const failing = host.checks.filter((c) => !c.ok);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {failing.length > 0 && (
        <Alert
          tone="danger"
          className="lg:col-span-2"
          title={t('docker.checksFailing', { count: failing.length })}
        >
          {failing.map((c) => c.detail).join(' · ')}
        </Alert>
      )}
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <ShieldCheck aria-hidden className="size-4" />
              {t('docker.checks')}
            </span>
          }
          description={t('docker.checksHint')}
        />
        <CardContent>
          <ul className="flex flex-col divide-y divide-border">
            {host.checks.map((c) => (
              <li key={c.key} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{t(`docker.check.${c.key}`)}</p>
                  <p className="text-sm break-words text-muted">{c.detail}</p>
                </div>
                <Badge tone={c.ok ? 'success' : 'danger'}>
                  {c.ok ? t('docker.ok') : t('docker.notOk')}
                </Badge>
              </li>
            ))}
          </ul>
          {host.docker_group_members.length > 0 && (
            <Alert
              tone="danger"
              className="mt-3"
              title={t('docker.groupMembers', { names: host.docker_group_members.join(', ') })}
            />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader title={t('docker.daemon')} description={t('docker.daemonHint')} />
        <CardContent>
          <InfoList
            items={[
              [t('docker.bindIp'), <code key="b">{host.daemon.default_bind_ip}</code>],
              [
                t('docker.userlandProxy'),
                host.daemon.userland_proxy ? t('docker.on') : t('docker.off'),
              ],
              [
                t('docker.liveRestore'),
                host.daemon.live_restore ? t('docker.on') : t('docker.off'),
              ],
              [t('docker.logRotate'), `${host.daemon.log_max_size} × ${host.daemon.log_max_file}`],
              [t('docker.apiVersion'), host.api_version ?? '—'],
              [
                t('docker.portRange'),
                t('docker.portRangeValue', {
                  from: host.port_range.from,
                  to: host.port_range.to,
                  used: host.ports_allocated,
                }),
              ],
            ]}
          />
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader
          title={t('docker.firewall')}
          description={t('docker.firewallHint')}
          action={
            <Button size="sm" variant="outline" onClick={() => sync.mutate()}>
              <RefreshCw aria-hidden />
              {t('docker.sync')}
            </Button>
          }
        />
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            {t('docker.syncedAt')}:{' '}
            {host.firewall.synced_at ? fmt.dateTime(host.firewall.synced_at) : '—'}
          </p>
          {host.firewall.open_ports.length === 0 ? (
            <p className="text-base">{t('docker.noOpenPorts')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {host.firewall.open_ports.map((p) => (
                <li
                  key={`${p.port}/${p.protocol}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span className="font-mono">
                    {p.port}/{p.protocol} ← {p.source}
                  </span>
                  <span className="text-sm text-muted">{p.note}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm">
            <AppLink
              href={`/admin/servers/${id}/firewall`}
              className="text-primary-text hover:underline"
            >
              {t('docker.openInFirewall')}
            </AppLink>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Containers({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [logsOf, setLogsOf] = useState<Container | null>(null);
  const control = useAction(
    (v: { container: string; action: string }) =>
      send('POST', '/api/v1/admin/servers/{id}/docker/containers/{container}:{action}', {
        path: { id, ...v },
      }),
    { invalidate: [['admin', 'server', id, 'containers']] },
  );
  const columns: ColumnDef<Container, unknown>[] = [
    {
      id: 'name',
      header: t('docker.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{row.original.name}</p>
          <p className="font-mono text-sm break-all text-muted">{row.original.image}</p>
        </div>
      ),
    },
    {
      id: 'state',
      header: t('servers.status'),
      accessorKey: 'state',
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-0.5">
          <span className="flex flex-wrap gap-1">
            <StatusBadge status={row.original.state} />
            {row.original.health && <StatusBadge status={row.original.health} />}
          </span>
          <span className="text-xs text-muted">{row.original.status}</span>
        </div>
      ),
    },
    {
      id: 'ports',
      header: t('docker.ports'),
      accessorFn: (c) => c.ports.join(', ') || '—',
      cell: ({ getValue }) => <span className="font-mono text-sm">{getValue<string>()}</span>,
    },
    {
      id: 'compose',
      header: t('docker.compose'),
      accessorFn: (c) => c.compose_project ?? '—',
    },
    { id: 'cpu', header: 'CPU', accessorFn: (c) => fmt.pct(c.cpu_pct, 1) },
    {
      id: 'mem',
      header: 'RAM',
      accessorFn: (c) => c.mem_mb,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {fmt.mb(row.original.mem_mb)}
          {row.original.mem_limit_mb !== null && (
            <span className="text-muted"> / {fmt.mb(row.original.mem_limit_mb)}</span>
          )}
        </span>
      ),
    },
    {
      id: 'actions',
      header: t('servers.actions'),
      enableSorting: false,
      cell: ({ row }) => {
        const c = row.original;
        const acts = c.state === 'running' ? (['restart', 'stop'] as const) : (['start'] as const);
        return (
          <div className="flex flex-wrap gap-2">
            {acts.map((a) => (
              <Button
                key={a}
                size="sm"
                variant="outline"
                onClick={() => control.mutate({ container: c.id, action: a })}
              >
                {t(`docker.action.${a}`)}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setLogsOf(c)}
              aria-label={t('docker.logsOf', { name: c.name })}
            >
              <ScrollText aria-hidden />
              {t('docker.logs')}
            </Button>
          </div>
        );
      },
    },
  ];
  return (
    <>
      <ListPage<Container>
        embedded
        title={t('docker.containers')}
        queryKey={['admin', 'server', id, 'containers']}
        fetch={() =>
          list('/api/v1/admin/servers/{id}/docker/containers', undefined, { path: { id } })
        }
        columns={columns}
        getRowId={(c) => c.id}
        primaryColumnId="name"
        search={false}
      />
      <Logs serverId={id} container={logsOf} onClose={() => setLogsOf(null)} />
    </>
  );
}

function Logs({
  serverId,
  container,
  onClose,
}: {
  serverId: string;
  container: Container | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const q = useQuery({
    queryKey: ['admin', 'server', serverId, 'containers', container?.id, 'logs'],
    enabled: container !== null,
    queryFn: () =>
      get('/api/v1/admin/servers/{id}/docker/containers/{container}/logs', {
        path: { id: serverId, container: container?.id ?? '' },
        query: { lines: 200 },
      }),
  });
  return (
    <Dialog open={container !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('docker.logsOf', { name: container?.name ?? '' })}
        description={t('docker.logsHint')}
        className="max-w-3xl"
      >
        {q.isPending ? (
          <Skeleton className="h-48" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <pre className="max-h-96 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-sm">
            {q.data.join('\n')}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Images({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [pruning, setPruning] = useState(false);
  const prune = useAction(
    () => send('POST', '/api/v1/admin/servers/{id}/docker/images:prune', { path: { id } }),
    { invalidate: [['admin', 'server', id, 'images']], onSuccess: () => setPruning(false) },
  );
  const columns: ColumnDef<Image, unknown>[] = [
    {
      id: 'tags',
      header: t('docker.tags'),
      accessorFn: (i) => i.tags.join(', '),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.tags.length === 0 ? (
            <Badge tone="warning">{t('docker.dangling')}</Badge>
          ) : (
            row.original.tags.map((x) => (
              <Badge key={x} tone="neutral">
                {x}
              </Badge>
            ))
          )}
          {row.original.rollback_of && (
            <Badge tone="info">{t('docker.rollbackOf', { image: row.original.rollback_of })}</Badge>
          )}
        </div>
      ),
    },
    {
      id: 'id',
      header: 'ID',
      accessorKey: 'id',
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.id.slice(0, 19)}</span>,
    },
    {
      id: 'use',
      header: t('servers.status'),
      accessorFn: (i) => (i.in_use ? 1 : 0),
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone={row.original.in_use ? 'success' : 'neutral'}>
            {row.original.in_use ? t('docker.inUse') : t('docker.unused')}
          </Badge>
          {row.original.update_available && (
            <Badge tone="info">{t('docker.updateAvailable')}</Badge>
          )}
        </span>
      ),
    },
    { id: 'size', header: t('docker.size'), accessorFn: (i) => fmt.mb(i.size_mb) },
    { id: 'created', header: t('docker.created'), accessorFn: (i) => fmt.dateTime(i.created_at) },
  ];
  return (
    <>
      <ListPage<Image>
        embedded
        search={false}
        title={t('docker.images')}
        actions={
          <Button size="sm" variant="outline" onClick={() => setPruning(true)}>
            <Trash2 aria-hidden />
            {t('docker.prune')}
          </Button>
        }
        queryKey={['admin', 'server', id, 'images']}
        fetch={() => list('/api/v1/admin/servers/{id}/docker/images', undefined, { path: { id } })}
        columns={columns}
        getRowId={(i) => i.id}
        primaryColumnId="tags"
      />
      <ConfirmDialog
        open={pruning}
        onOpenChange={setPruning}
        title={t('docker.pruneTitle')}
        description={t('docker.pruneHint')}
        confirmLabel={t('docker.prune')}
        onConfirm={() => prune.mutateAsync().then(() => undefined)}
      />
    </>
  );
}

function Volumes({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [deleting, setDeleting] = useState<Volume | null>(null);
  const del = useAction(
    (v: Volume) =>
      send('DELETE', '/api/v1/admin/servers/{id}/docker/volumes/{volume}', {
        path: { id, volume: v.name },
      }),
    { invalidate: [['admin', 'server', id, 'volumes']], onSuccess: () => setDeleting(null) },
  );
  const columns: ColumnDef<Volume, unknown>[] = [
    {
      id: 'name',
      header: t('docker.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-mono">{row.original.name}</p>
          {row.original.compose_project && (
            <p className="text-sm text-muted">
              {t('docker.compose')}: {row.original.compose_project}
            </p>
          )}
        </div>
      ),
    },
    { id: 'size', header: t('docker.size'), accessorFn: (v) => fmt.mb(v.size_mb) },
    {
      id: 'usedBy',
      header: t('docker.usedBy'),
      accessorFn: (v) => v.used_by.join(', ') || '—',
      cell: ({ getValue }) => <span className="font-mono text-sm">{getValue<string>()}</span>,
    },
    {
      id: 'backup',
      header: t('docker.lastBackup'),
      accessorFn: (v) => v.last_backup_at ?? '',
      cell: ({ row }) =>
        row.original.last_backup_at ? (
          fmt.rel(row.original.last_backup_at)
        ) : (
          <Badge tone="warning">{t('docker.noBackup')}</Badge>
        ),
    },
    {
      id: 'actions',
      header: t('servers.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          disabled={row.original.in_use}
          title={row.original.in_use ? t('docker.volumeInUse') : undefined}
          onClick={() => setDeleting(row.original)}
          aria-label={t('docker.deleteVolume', { name: row.original.name })}
        >
          <Trash2 aria-hidden />
          {t('docker.delete')}
        </Button>
      ),
    },
  ];
  return (
    <>
      <ListPage<Volume>
        embedded
        search={false}
        title={t('docker.volumes')}
        queryKey={['admin', 'server', id, 'volumes']}
        fetch={() => list('/api/v1/admin/servers/{id}/docker/volumes', undefined, { path: { id } })}
        columns={columns}
        getRowId={(v) => v.name}
        primaryColumnId="name"
      />
      <p className="mt-3 text-sm text-muted">{t('docker.volumeBackupHint')}</p>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('docker.deleteVolumeTitle', { name: deleting?.name ?? '' })}
        description={t('docker.deleteVolumeHint')}
        {...(deleting ? { confirmName: deleting.name } : {})}
        confirmLabel={t('docker.delete')}
        onConfirm={() => (deleting ? del.mutateAsync(deleting).then(() => undefined) : undefined)}
      />
    </>
  );
}

function Networks({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const columns: ColumnDef<Network, unknown>[] = [
    {
      id: 'name',
      header: t('docker.name'),
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
    },
    { id: 'driver', header: t('docker.driver'), accessorKey: 'driver' },
    { id: 'containers', header: t('docker.containers'), accessorKey: 'containers' },
    {
      id: 'internal',
      header: t('docker.internal'),
      accessorFn: (n) => (n.internal ? t('docker.on') : t('docker.off')),
    },
  ];
  return (
    <>
      <ListPage<Network>
        embedded
        search={false}
        title={t('docker.networks')}
        queryKey={['admin', 'server', id, 'networks']}
        fetch={() =>
          list('/api/v1/admin/servers/{id}/docker/networks', undefined, { path: { id } })
        }
        columns={columns}
        getRowId={(n) => n.id}
        primaryColumnId="name"
      />
      <p className="mt-3 text-sm text-muted">
        {t('docker.composeHint')}{' '}
        <AppLink href="/admin/compose-projects" className="text-primary-text hover:underline">
          {t('compose.title')}
        </AppLink>
      </p>
    </>
  );
}
