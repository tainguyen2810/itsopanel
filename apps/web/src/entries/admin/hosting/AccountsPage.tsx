import { useQuery } from '@tanstack/react-query';
import { Archive, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { useSession } from '@/shared/session/SessionContext';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { buttonVariants } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { ProgressBar } from '@/ui/ProgressBar';
import { list, type Row } from '../api';
import { pct } from '../servers/ServersPage';

type Account = Row<'/api/v1/admin/hosting-accounts'>;
export const LIFECYCLE = [
  'pending',
  'provisioning',
  'active',
  'suspended',
  'migrating',
  'failed',
] as const;

export default function AccountsPage() {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const fmt = useFmt();
  const { user } = useSession();
  const servers = useQuery({
    queryKey: ['admin', 'servers', { q: '' }],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const columns: ColumnDef<Account, unknown>[] = [
    {
      id: 'username',
      header: t('accounts.username'),
      accessorKey: 'username',
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/hosting-accounts/${row.original.uuid}`}
            className="font-mono font-medium hover:underline"
          >
            {row.original.username}
          </AppLink>
          <p className="text-sm text-muted">{row.original.owner.name}</p>
        </div>
      ),
    },
    {
      id: 'server',
      header: t('accounts.server'),
      accessorFn: (a) => a.server.name,
      cell: ({ row }) => (
        <AppLink href={`/admin/servers/${row.original.server.uuid}`} className="hover:underline">
          {row.original.server.name}
        </AppLink>
      ),
    },
    {
      id: 'package',
      header: t('accounts.package'),
      accessorFn: (a) => a.package.name,
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          {row.original.package.name}
          <Badge tone="neutral">v{row.original.package.version}</Badge>
        </span>
      ),
    },
    {
      id: 'disk',
      header: t('accounts.usage.disk'),
      accessorFn: (a) => pct(a.usage.disk_mb.used, a.usage.disk_mb.limit),
      cell: ({ row, getValue }) => (
        <div className="flex w-36 flex-col gap-1">
          <ProgressBar
            label={`${row.original.username} ${t('accounts.usage.disk')}`}
            value={getValue<number>()}
            thresholds={{ warn: 75, danger: 90 }}
          />
          <span className="text-xs text-muted tabular-nums">
            {fmt.mb(row.original.usage.disk_mb.used)} / {fmt.mb(row.original.usage.disk_mb.limit)}
          </span>
        </div>
      ),
    },
    {
      id: 'sites',
      header: t('accounts.usage.websites'),
      accessorFn: (a) => a.usage.websites.used,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.usage.websites.used}/{row.original.usage.websites.limit}
        </span>
      ),
    },
    {
      id: 'state',
      header: t('accounts.state'),
      accessorKey: 'lifecycle_state',
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={row.original.lifecycle_state} />
          {row.original.legal_hold && <Badge tone="danger">{t('accounts.legalHold')}</Badge>}
        </div>
      ),
    },
  ];
  return (
    <ListPage<Account>
      title={t('accounts.title')}
      description={t('accounts.description')}
      actions={
        <>
          {user.role === 'SUPER_ADMIN' && (
            <AppLink
              href="/admin/hosting-accounts/terminated"
              className={buttonVariants({ variant: 'outline' })}
            >
              <Archive aria-hidden />
              {t('accounts.terminatedLink')}
            </AppLink>
          )}
          <AppLink href="/admin/hosting-accounts/new" className={buttonVariants()}>
            <Plus aria-hidden />
            {t('accounts.add')}
          </AppLink>
        </>
      }
      queryKey={['admin', 'accounts']}
      // Tài khoản đã chấm dứt/xóa nằm ở trang riêng; danh sách chính khớp số trên dashboard.
      fetch={async (q) =>
        (await list('/api/v1/admin/hosting-accounts', q)).filter(
          (a) => a.lifecycle_state !== 'terminated' && a.lifecycle_state !== 'purged',
        )
      }
      filters={[
        {
          key: 'server',
          label: t('accounts.server'),
          options: (servers.data ?? []).map((s) => ({ value: s.uuid, label: s.name })),
        },
        {
          key: 'lifecycle_state',
          label: t('accounts.state'),
          options: LIFECYCLE.map((s) => ({ value: s, label: tc(`status.${s}`) })),
        },
      ]}
      columns={columns}
      getRowId={(a) => a.uuid}
      primaryColumnId="username"
    />
  );
}
