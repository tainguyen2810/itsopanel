import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { buttonVariants } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { list, type Row } from '../api';

type Package = Row<'/api/v1/admin/hosting-packages'>;

export default function PackagesPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const columns: ColumnDef<Package, unknown>[] = [
    {
      id: 'name',
      header: t('packages.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/hosting-packages/${row.original.uuid}`}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </AppLink>
          <p className="font-mono text-sm text-muted">{row.original.code}</p>
        </div>
      ),
    },
    {
      id: 'version',
      header: t('packages.version'),
      accessorKey: 'current_version',
      cell: ({ row }) => <Badge tone="neutral">v{row.original.current_version}</Badge>,
    },
    {
      id: 'disk',
      header: t('packages.limits.disk_mb'),
      accessorFn: (p) => fmt.mb(p.limits.disk_mb),
    },
    { id: 'ram', header: t('packages.limits.ram_mb'), accessorFn: (p) => fmt.mb(p.limits.ram_mb) },
    {
      id: 'cpu',
      header: t('packages.limits.cpu_percent'),
      accessorFn: (p) => `${fmt.num(p.limits.cpu_percent)}%`,
    },
    {
      id: 'sites',
      header: t('packages.limits.website_limit'),
      accessorFn: (p) => p.limits.website_limit,
      cell: ({ getValue }) => <span className="tabular-nums">{fmt.num(getValue<number>())}</span>,
    },
    {
      id: 'php',
      header: t('packages.limits.php_versions'),
      accessorFn: (p) => p.limits.php_versions.join(', '),
    },
    {
      id: 'accounts',
      header: t('packages.accounts'),
      accessorKey: 'account_count',
      cell: ({ row }) => (
        <span className="tabular-nums">{fmt.num(row.original.account_count)}</span>
      ),
    },
    {
      id: 'state',
      header: t('packages.state'),
      accessorFn: (p) => (p.is_active ? 'active' : 'disabled'),
      cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
    },
  ];
  return (
    <ListPage<Package>
      title={t('packages.title')}
      description={t('packages.description')}
      actions={
        <AppLink href="/admin/hosting-packages/new" className={buttonVariants()}>
          <Plus aria-hidden />
          {t('packages.add')}
        </AppLink>
      }
      queryKey={['admin', 'packages']}
      fetch={(q) => list('/api/v1/admin/hosting-packages', q)}
      columns={columns}
      getRowId={(p) => p.uuid}
      primaryColumnId="name"
    />
  );
}
