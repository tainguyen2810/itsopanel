import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { useSession } from '@/shared/session/SessionContext';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/DropdownMenu';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { ServerNav, useServer } from './common';

type Php = Row<'/api/v1/admin/servers/{id}/php-versions'>;
/** Phiên bản PHP có recipe cài (Ondřej PPA trên Ubuntu 24.04). */
export const PHP_SUPPORTED = ['8.1', '8.2', '8.3', '8.4'] as const;

export default function ServerPhpPage() {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const server = useServer();
  const key = ['admin', 'server', server.id, 'php'];
  const versions = useQuery({
    queryKey: [...key, 'all'],
    queryFn: () =>
      list('/api/v1/admin/servers/{id}/php-versions', undefined, { path: { id: server.id } }),
  });
  const install = useAction((v: string) =>
    send('POST', '/api/v1/admin/servers/{id}/software/{key}:{action}', {
      path: { id: server.id, key: `php${v}`, action: 'install' },
    }),
  );
  const sa = user.role === 'SUPER_ADMIN';
  const missing = PHP_SUPPORTED.filter(
    (v) => !(versions.data ?? []).some((x) => x.version === v && x.installed),
  );
  const columns: ColumnDef<Php, unknown>[] = [
    {
      id: 'version',
      header: t('php.version'),
      accessorKey: 'version',
      cell: ({ row }) => (
        <span className="flex items-center gap-2 font-medium">
          PHP {row.original.version}
          {row.original.default && <Badge tone="primary">{t('php.default')}</Badge>}
        </span>
      ),
    },
    {
      id: 'state',
      header: t('servers.status'),
      accessorFn: (x) => (x.installed ? 'installed' : 'available'),
      cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
    },
    { id: 'sites', header: t('php.sites'), accessorKey: 'sites_count' },
    {
      id: 'ext',
      header: t('php.extensions'),
      accessorFn: (x) => x.extensions.join(', '),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.extensions.map((e) => (
            <Badge key={e} tone="neutral">
              {e}
            </Badge>
          ))}
        </div>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        nav={<ServerNav current="php" />}
        title={t('php.title')}
        description={t('php.description')}
        actions={
          sa && missing.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button>
                  <Plus aria-hidden />
                  {t('php.install')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {missing.map((v) => (
                  <DropdownMenuItem key={v} onSelect={() => install.mutate(v)}>
                    PHP {v}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />
      <ListPage<Php>
        embedded
        title={t('php.title')}
        queryKey={key}
        fetch={() =>
          list('/api/v1/admin/servers/{id}/php-versions', undefined, { path: { id: server.id } })
        }
        columns={columns}
        getRowId={(x) => x.version}
        primaryColumnId="version"
        search={false}
      />
    </>
  );
}
