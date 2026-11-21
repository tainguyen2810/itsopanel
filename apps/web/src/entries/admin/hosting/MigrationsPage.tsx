import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import type { ColumnDef } from '@/ui/DataTable';
import { list } from '../api';
import type { Migration } from './accounts';

const STATES = [
  'syncing',
  'verifying',
  'cutover',
  'holding',
  'completed',
  'rolled_back',
  'failed',
] as const;

/**
 * Danh sách lượt chuyển server (D-93): mọi account trong phạm vi (ADMIN chỉ thấy lượt mà cả hai server đều trong
 * phạm vi, như API). Mỗi dòng mở wizard chuyển của account để theo dõi/cutover/hoàn tác/dọn nguồn.
 */
export default function MigrationsPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const columns: ColumnDef<Migration, unknown>[] = [
    {
      id: 'account',
      header: t('migrations.account'),
      accessorFn: (m) => m.hosting_account.username,
      cell: ({ row }) => (
        <AppLink
          href={`/admin/hosting-accounts/${row.original.hosting_account.uuid}/migrate`}
          className="font-mono font-medium hover:underline"
        >
          {row.original.hosting_account.username}
        </AppLink>
      ),
    },
    {
      id: 'route',
      header: t('migrations.route'),
      accessorFn: (m) => `${m.source_server.name} → ${m.target_server.name}`,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          {row.original.source_server.name}
          <ArrowRight aria-label={t('migrations.to')} className="size-4 text-muted" />
          {row.original.target_server.name}
        </span>
      ),
    },
    {
      id: 'state',
      header: t('migrate.state'),
      accessorFn: (m) => m.state,
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={row.original.state} />
          {row.original.error && (
            <span className="max-w-72 text-xs text-danger-text">{row.original.error}</span>
          )}
        </div>
      ),
    },
    {
      id: 'downtime',
      header: t('migrate.downtime'),
      accessorFn: (m) => m.downtime_sec ?? -1,
      cell: ({ row }) =>
        row.original.downtime_sec === null
          ? '—'
          : t('migrate.seconds', { count: row.original.downtime_sec }),
    },
    {
      id: 'cleanup',
      header: t('migrate.cleanupAt'),
      accessorFn: (m) => m.cleanup_after ?? '',
      cell: ({ row }) => fmt.opt(row.original.cleanup_after),
    },
    {
      id: 'updated',
      header: t('migrate.updatedAt'),
      accessorFn: (m) => m.updated_at,
      cell: ({ row }) => fmt.dateTime(row.original.updated_at),
    },
  ];
  return (
    <ListPage<Migration>
      title={t('migrations.title')}
      description={t('migrations.description')}
      queryKey={['admin', 'migrations']}
      fetch={async (q) => {
        const rows = await list('/api/v1/admin/account-migrations');
        const st = q.filters.state;
        return st ? rows.filter((m) => m.state === st) : rows;
      }}
      search={false}
      filters={[
        {
          key: 'state',
          label: t('migrate.state'),
          options: STATES.map((s) => ({ value: s, label: t(`migrations.states.${s}`) })),
        },
      ]}
      columns={columns}
      getRowId={(m) => m.uuid}
      primaryColumnId="account"
      empty={<p className="p-6 text-center text-base text-muted">{t('migrations.empty')}</p>}
    />
  );
}
