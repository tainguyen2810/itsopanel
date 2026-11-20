import { useTranslation } from 'react-i18next';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { useSession } from '@/shared/session/SessionContext';
import { StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { ServerNav, useServer } from './common';

type Software = Row<'/api/v1/admin/servers/{id}/software'>;

/** Hành động hợp lệ theo trạng thái phần mềm. */
export function softwareActions(s: Pick<Software, 'state'>): ('install' | 'upgrade' | 'remove')[] {
  switch (s.state) {
    case 'available':
    case 'failed':
      return ['install'];
    case 'upgradable':
      return ['upgrade', 'remove'];
    case 'installed':
      return ['remove'];
    default:
      return [];
  }
}

export default function ServerSoftwarePage() {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const server = useServer();
  const run = useAction((v: { key: string; action: string }) =>
    send('POST', '/api/v1/admin/servers/{id}/software/{key}:{action}', {
      path: { id: server.id, ...v },
    }),
  );
  const sa = user.role === 'SUPER_ADMIN';
  const columns: ColumnDef<Software, unknown>[] = [
    {
      id: 'name',
      header: t('software.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div>
          <p className="font-medium">{row.original.name}</p>
          <p className="font-mono text-sm text-muted">{row.original.key}</p>
        </div>
      ),
    },
    {
      id: 'category',
      header: t('software.category'),
      accessorFn: (s) => t(`software.categories.${s.category}`, { defaultValue: s.category }),
    },
    {
      id: 'installed',
      header: t('software.installed'),
      accessorFn: (s) => s.installed_version ?? '—',
    },
    { id: 'latest', header: t('software.latest'), accessorKey: 'latest_version' },
    {
      id: 'state',
      header: t('servers.status'),
      accessorKey: 'state',
      cell: ({ row }) => <StatusBadge status={row.original.state} />,
    },
    ...(sa
      ? [
          {
            id: 'actions',
            header: t('servers.actions'),
            enableSorting: false,
            cell: ({ row }) => (
              <div className="flex gap-2">
                {softwareActions(row.original).map((a) => (
                  <Button
                    key={a}
                    size="sm"
                    variant={a === 'remove' ? 'outline' : 'primary'}
                    onClick={() => run.mutate({ key: row.original.key, action: a })}
                  >
                    {t(`software.actions.${a}`)}
                  </Button>
                ))}
              </div>
            ),
          } satisfies ColumnDef<Software, unknown>,
        ]
      : []),
  ];
  return (
    <>
      <PageHeader
        nav={<ServerNav current="software" />}
        title={t('software.title')}
        description={t('software.description')}
      />
      <ListPage<Software>
        embedded
        title={t('software.title')}
        queryKey={['admin', 'server', server.id, 'software']}
        fetch={() =>
          list('/api/v1/admin/servers/{id}/software', undefined, { path: { id: server.id } })
        }
        columns={columns}
        getRowId={(s) => s.key}
        primaryColumnId="name"
        search={false}
      />
    </>
  );
}
