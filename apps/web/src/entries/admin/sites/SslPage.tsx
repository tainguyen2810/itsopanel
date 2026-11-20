import { useState } from 'react';
import { ShieldAlert, ShieldCheck, ShieldX, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { StatCard } from '@/ui/StatCard';
import { useQuery } from '@tanstack/react-query';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { RowMenu } from './common';
import { certDaysLeft } from './forms';

type Cert = Row<'/api/v1/admin/certificates'>;
const STATUSES = ['valid', 'expiring', 'expired', 'pending', 'failed'] as const;

export default function SslPage() {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const fmt = useFmt();
  const [removing, setRemoving] = useState<Cert | null>(null);
  const all = useQuery({
    queryKey: ['admin', 'certificates', 'all'],
    queryFn: () => list('/api/v1/admin/certificates'),
  });
  const renew = useAction((c: Cert) =>
    send('POST', '/api/v1/admin/certificates/{id}:renew', { path: { id: c.uuid }, body: {} }),
  );
  const remove = useAction(
    (c: Cert) => send('DELETE', '/api/v1/admin/certificates/{id}', { path: { id: c.uuid } }),
    { onSuccess: () => setRemoving(null) },
  );
  const count = (s: string) => (all.data ?? []).filter((c) => c.status === s).length;
  const columns: ColumnDef<Cert, unknown>[] = [
    {
      id: 'website',
      header: t('ssl.website'),
      accessorFn: (c) => c.website.primary_domain,
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/websites/${row.original.website.uuid}`}
            className="font-medium break-all hover:underline"
          >
            {row.original.website.primary_domain}
          </AppLink>
          {row.original.domains.length > 1 && (
            <p className="text-sm break-all text-muted">
              {row.original.domains.slice(1).join(', ')}
            </p>
          )}
        </div>
      ),
    },
    {
      id: 'source',
      header: t('ssl.source'),
      accessorKey: 'source',
      cell: ({ row }) => (
        <Badge tone={row.original.source === 'acme' ? 'info' : 'neutral'}>
          {t(`ssl.sources.${row.original.source}`)}
        </Badge>
      ),
    },
    { id: 'issuer', header: t('sites.issuer'), accessorKey: 'issuer' },
    {
      id: 'expires',
      header: t('sites.expires'),
      accessorFn: (c) => c.not_after,
      cell: ({ row }) => {
        const left = certDaysLeft(row.original.not_after) ?? 0;
        return (
          <div className="flex flex-col">
            <span>{fmt.date(row.original.not_after)}</span>
            <span className="text-xs text-muted">
              {left < 0 ? t('sites.certExpired') : t('sites.certDays', { count: left })}
            </span>
          </div>
        );
      },
    },
    {
      id: 'auto',
      header: t('ssl.autoRenew'),
      accessorFn: (c) => (c.auto_renew ? 1 : 0),
      cell: ({ row }) => (row.original.auto_renew ? t('sites.on') : t('sites.off')),
    },
    {
      id: 'status',
      header: t('sites.status'),
      accessorKey: 'status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('sites.certActions', { name: row.original.website.primary_domain })}
          actions={[
            {
              label: t('sites.renew'),
              onSelect: () => renew.mutate(row.original),
              hidden: row.original.source !== 'acme',
            },
            { label: t('sites.remove'), onSelect: () => setRemoving(row.original), danger: true },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Cert>
        title={t('ssl.title')}
        description={t('ssl.description')}
        queryKey={['admin', 'certificates']}
        fetch={async (q) => {
          const rows = await list('/api/v1/admin/certificates');
          const s = q.filters.status;
          const term = q.q?.toLowerCase();
          return rows.filter(
            (c) => (!s || c.status === s) && (!term || c.domains.some((d) => d.includes(term))),
          );
        }}
        filters={[
          {
            key: 'status',
            label: t('sites.status'),
            options: STATUSES.map((s) => ({ value: s, label: tc(`status.${s}`) })),
          },
        ]}
        columns={columns}
        getRowId={(c) => c.uuid}
        primaryColumnId="website"
      >
        <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={Lock} label={t('ssl.total')} value={String(all.data?.length ?? '—')} />
          <StatCard
            icon={ShieldCheck}
            tone="success"
            label={tc('status.valid')}
            value={String(count('valid'))}
          />
          <StatCard
            icon={ShieldAlert}
            tone="warning"
            label={tc('status.expiring')}
            value={String(count('expiring'))}
          />
          <StatCard
            icon={ShieldX}
            tone="danger"
            label={t('ssl.problem')}
            value={String(count('expired') + count('failed'))}
          />
        </div>
      </ListPage>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('sites.removeCertTitle')}
        description={t('sites.removeCertHint')}
        confirmLabel={t('sites.remove')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
    </>
  );
}
