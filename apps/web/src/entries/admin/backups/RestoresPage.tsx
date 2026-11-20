import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { buttonVariants } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { list, type Row } from '../api';
import { Mono, useAccountFilter } from '../sites/common';

type Restore = Row<'/api/v1/admin/restores'>;

export default function RestoresPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const accountFilter = useAccountFilter();
  const columns: ColumnDef<Restore, unknown>[] = [
    {
      id: 'account',
      header: t('sites.account'),
      accessorFn: (r) => r.hosting_account.username,
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/hosting-accounts/${row.original.hosting_account.uuid}`}
            className="font-medium hover:underline"
          >
            {row.original.hosting_account.username}
          </AppLink>
          <p className="text-sm text-muted">
            {t('rs.toServer', { name: row.original.target_server.name })}
          </p>
        </div>
      ),
    },
    {
      id: 'mode',
      header: t('rs.mode'),
      accessorKey: 'mode',
      cell: ({ row }) => (
        <Badge tone={row.original.mode === 'overwrite' ? 'warning' : 'info'}>
          {t(`rs.modes.${row.original.mode}.title`)}
        </Badge>
      ),
    },
    {
      id: 'items',
      header: t('rs.items'),
      accessorFn: (r) => r.items.join(' '),
      cell: ({ row }) => (
        <ul className="flex flex-col gap-0.5">
          {row.original.items.map((i) => (
            <li key={i}>
              <Mono>{i}</Mono>
            </li>
          ))}
        </ul>
      ),
    },
    { id: 'by', header: t('rs.requestedBy'), accessorFn: (r) => r.requested_by.name },
    {
      id: 'created',
      header: t('rs.created'),
      accessorKey: 'created_at',
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{fmt.dateTime(row.original.created_at)}</span>
      ),
    },
    {
      id: 'state',
      header: t('sites.status'),
      accessorKey: 'state',
      cell: ({ row }) =>
        row.original.job_uuid ? (
          <AppLink
            href={`/admin/jobs/${row.original.job_uuid}`}
            aria-label={t('rs.jobOf', { name: row.original.hosting_account.username })}
          >
            <StatusBadge status={row.original.state} />
          </AppLink>
        ) : (
          <StatusBadge status={row.original.state} />
        ),
    },
  ];
  return (
    <ListPage<Restore>
      title={t('rs.title')}
      description={t('rs.description')}
      actions={
        <AppLink href="/admin/restores/new" className={buttonVariants()}>
          <History aria-hidden />
          {t('rs.new')}
        </AppLink>
      }
      queryKey={['admin', 'restores']}
      fetch={async (q) => {
        const rows = await list('/api/v1/admin/restores');
        const acc = q.filters.hosting_account;
        return acc ? rows.filter((r) => r.hosting_account.uuid === acc) : rows;
      }}
      filters={[accountFilter]}
      search={false}
      columns={columns}
      getRowId={(r) => r.uuid}
      primaryColumnId="account"
    />
  );
}
