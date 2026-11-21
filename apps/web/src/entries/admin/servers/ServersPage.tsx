import { Plus } from 'lucide-react';
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

type Server = Row<'/api/v1/admin/servers'>;

export const pct = (used: number, total: number) => (total > 0 ? (used * 100) / total : 0);

/** Số ngày còn lại của chứng chỉ mTLS (làm tròn xuống; ≤ 0 là đã hết hạn). */
export const certDays = (notAfter: string, now = Date.now()) =>
  Math.floor((Date.parse(notAfter) - now) / 86_400_000);

export default function ServersPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { user } = useSession();
  const bar = (label: string, v: number) => (
    <div className="flex w-28 items-center gap-2">
      <ProgressBar
        label={label}
        value={v}
        thresholds={{ warn: 75, danger: 90 }}
        className="flex-1"
      />
      <span className="w-10 text-right text-xs text-muted tabular-nums">{fmt.pct(v)}</span>
    </div>
  );
  const columns: ColumnDef<Server, unknown>[] = [
    {
      id: 'name',
      header: t('servers.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/servers/${row.original.uuid}`}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </AppLink>
          <p className="text-sm text-muted">{row.original.hostname}</p>
        </div>
      ),
    },
    {
      id: 'ip',
      header: t('servers.ip'),
      accessorFn: (s) => s.ip_addresses.join(', '),
      cell: ({ row }) => (
        <span className="font-mono text-sm">{row.original.ip_addresses.at(-1)}</span>
      ),
    },
    {
      id: 'roles',
      header: t('servers.roles'),
      accessorFn: (s) => s.role_tags.join(', '),
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.role_tags.map((r) => (
            <Badge key={r} tone="neutral">
              {t(`servers.role.${r}`)}
            </Badge>
          ))}
        </div>
      ),
    },
    {
      id: 'role',
      header: t('servers.nodeRole'),
      accessorKey: 'node_role',
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-1">
          <span className="text-sm">{t(`servers.nodeRoles.${row.original.node_role}`)}</span>
          <span className="text-xs text-muted">
            {t(`servers.transports.${row.original.transport}`)}
          </span>
        </div>
      ),
    },
    {
      id: 'status',
      header: t('servers.status'),
      accessorKey: 'connection',
      cell: ({ row }) => {
        const s = row.original;
        const days = s.cert ? certDays(s.cert.not_after) : null;
        return (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge status={s.connection === 'online' ? s.status : s.connection} />
            {s.connection !== 'online' && s.last_seen_at && (
              <span className="text-xs text-muted">
                {t('servers.lastSeen', { time: fmt.dateTime(s.last_seen_at) })}
              </span>
            )}
            {s.drift !== null && <StatusBadge status="drift" />}
            {days !== null && days <= 7 && (
              <Badge tone={days <= 0 ? 'danger' : 'warning'}>
                {days <= 0 ? t('servers.certExpired') : t('servers.certDays', { count: days })}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      id: 'cpu',
      header: t('dashboard.cpu'),
      accessorFn: (s) => s.resources.cpu_pct,
      cell: ({ row }) => bar(`${row.original.name} CPU`, row.original.resources.cpu_pct),
    },
    {
      id: 'ram',
      header: t('dashboard.ram'),
      accessorFn: (s) => pct(s.resources.ram_used_mb, s.resources.ram_mb),
      cell: ({ getValue, row }) => bar(`${row.original.name} RAM`, getValue<number>()),
    },
    {
      id: 'disk',
      header: t('dashboard.disk'),
      accessorFn: (s) => pct(s.resources.disk_used_mb, s.resources.disk_mb),
      cell: ({ getValue, row }) =>
        bar(`${row.original.name} ${t('dashboard.disk')}`, getValue<number>()),
    },
    {
      id: 'accounts',
      header: t('servers.accounts'),
      accessorKey: 'account_count',
      cell: ({ row }) => (
        <span className="tabular-nums">{fmt.num(row.original.account_count)}</span>
      ),
    },
  ];
  return (
    <ListPage<Server>
      title={t('servers.title')}
      description={t('servers.description')}
      actions={
        user.role === 'SUPER_ADMIN' ? (
          <AppLink href="/admin/servers/new" className={buttonVariants()}>
            <Plus aria-hidden />
            {t('servers.add')}
          </AppLink>
        ) : undefined
      }
      queryKey={['admin', 'servers']}
      fetch={(q) => list('/api/v1/admin/servers', q)}
      columns={columns}
      getRowId={(s) => s.uuid}
      primaryColumnId="name"
    />
  );
}
