import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { DetailPage } from '@/shared/page/DetailPage';
import { ListPage } from '@/shared/page/ListPage';
import { ErrorState } from '@/shared/page/states';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { Skeleton } from '@/ui/Feedback';
import { get, list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { ServerNav, useServer } from './common';

type Container = Row<'/api/v1/admin/servers/{id}/docker/containers'>;
type Image = Row<'/api/v1/admin/servers/{id}/docker/images'>;
type Volume = Row<'/api/v1/admin/servers/{id}/docker/volumes'>;
type Network = Row<'/api/v1/admin/servers/{id}/docker/networks'>;

export default function ServerDockerPage() {
  const { t } = useTranslation('admin');
  const server = useServer();
  return (
    <>
      <DetailPage
        nav={<ServerNav current="docker" />}
        title={t('docker.title')}
        description={t('docker.description')}
        tabs={[
          {
            value: 'containers',
            label: t('docker.containers'),
            content: <Containers id={server.id} />,
          },
          { value: 'images', label: t('docker.images'), content: <Images id={server.id} /> },
          { value: 'volumes', label: t('docker.volumes'), content: <Volumes id={server.id} /> },
          { value: 'networks', label: t('docker.networks'), content: <Networks id={server.id} /> },
        ]}
      />
    </>
  );
}

function Containers({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [logsOf, setLogsOf] = useState<Container | null>(null);
  const control = useAction((v: { container: string; action: string }) =>
    send('POST', '/api/v1/admin/servers/{id}/docker/containers/{container}:{action}', {
      path: { id, ...v },
    }),
  );
  const columns: ColumnDef<Container, unknown>[] = [
    {
      id: 'name',
      header: t('docker.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{row.original.name}</p>
          <p className="font-mono text-sm text-muted">{row.original.image}</p>
        </div>
      ),
    },
    {
      id: 'state',
      header: t('servers.status'),
      accessorKey: 'state',
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-0.5">
          <StatusBadge status={row.original.state} />
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
    { id: 'mem', header: 'RAM', accessorFn: (c) => fmt.mb(c.mem_mb) },
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
  const columns: ColumnDef<Image, unknown>[] = [
    {
      id: 'tags',
      header: t('docker.tags'),
      accessorFn: (i) => i.tags.join(', '),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.tags.map((x) => (
            <Badge key={x} tone="neutral">
              {x}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: 'id',
      header: 'ID',
      accessorKey: 'id',
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.id.slice(0, 19)}</span>,
    },
    { id: 'size', header: t('docker.size'), accessorFn: (i) => fmt.mb(i.size_mb) },
    { id: 'created', header: t('docker.created'), accessorFn: (i) => fmt.dateTime(i.created_at) },
  ];
  return (
    <ListPage<Image>
      embedded
      search={false}
      title={t('docker.images')}
      queryKey={['admin', 'server', id, 'images']}
      fetch={() => list('/api/v1/admin/servers/{id}/docker/images', undefined, { path: { id } })}
      columns={columns}
      getRowId={(i) => i.id}
      primaryColumnId="tags"
    />
  );
}

function Volumes({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const columns: ColumnDef<Volume, unknown>[] = [
    {
      id: 'name',
      header: t('docker.name'),
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
    },
    { id: 'driver', header: t('docker.driver'), accessorKey: 'driver' },
    { id: 'size', header: t('docker.size'), accessorFn: (v) => fmt.mb(v.size_mb) },
    {
      id: 'inUse',
      header: t('servers.status'),
      accessorFn: (v) => (v.in_use ? t('docker.inUse') : t('docker.unused')),
    },
  ];
  return (
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
