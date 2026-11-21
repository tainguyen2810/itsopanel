import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ListPage } from '@/shared/page/ListPage';
import { useSession } from '@/shared/session/SessionContext';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { useFmt } from '@/shared/format/useFmt';
import { VerifyBadge, type Snapshot } from '@/shared/hosting/pages/backup';
import { SnapshotsTab as SharedSnapshotsTab } from '@/shared/hosting/pages/SnapshotsTab';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { latestPerAccount, verifyState, VERIFY_WINDOW_DAYS } from './rules';

export type { Snapshot };
export { VerifyBadge };

/** Lịch sử snapshot (Admin): thêm kiểm chứng ngay và xóa (chỉ Super Admin). */
export function SnapshotsTab() {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState<Snapshot | null>(null);
  const dests = useQuery({
    queryKey: ['admin', 'backups', 'destinations'],
    queryFn: () => list('/api/v1/admin/backup-destinations'),
  });
  const verify = useAction((s: Snapshot) =>
    send('POST', '/api/v1/admin/backup-snapshots/{id}:verify', { path: { id: s.uuid } }),
  );
  const remove = useAction(
    (s: Snapshot) =>
      send('DELETE', '/api/v1/admin/backup-snapshots/{id}', { path: { id: s.uuid } }),
    { onSuccess: () => setDeleting(null) },
  );
  return (
    <>
      <SharedSnapshotsTab
        extraFilters={[
          {
            key: 'destination',
            label: t('bk.destination'),
            options: (dests.data ?? []).map((d) => ({ value: d.uuid, label: d.name })),
          },
        ]}
        onRestore={(s) =>
          void navigate({ to: '/restores/new', search: { snapshot: s.uuid } } as never)
        }
        extraActions={(s) => [
          { label: t('bk.verifyNow'), onSelect: () => verify.mutate(s) },
          {
            label: t('bk.delete'),
            onSelect: () => setDeleting(s),
            danger: true,
            hidden: user.role !== 'SUPER_ADMIN' || s.locked_until !== null,
          },
        ]}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('bk.deleteTitle', { id: deleting?.restic_snapshot_id ?? '' })}
        description={t('bk.deleteHint')}
        confirmLabel={t('bk.delete')}
        onConfirm={() =>
          deleting ? remove.mutateAsync(deleting).then(() => undefined) : undefined
        }
      />
    </>
  );
}

export function VerifyTab() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const verify = useAction((s: Snapshot) =>
    send('POST', '/api/v1/admin/backup-snapshots/{id}:verify', { path: { id: s.uuid } }),
  );
  const columns: ColumnDef<Snapshot, unknown>[] = [
    {
      id: 'account',
      header: t('sites.account'),
      accessorFn: (s) => s.hosting_account?.username ?? '',
    },
    {
      id: 'taken',
      header: t('bk.latest'),
      accessorKey: 'taken_at',
      cell: ({ row }) => fmt.dateTime(row.original.taken_at),
    },
    { id: 'dest', header: t('bk.destination'), accessorFn: (s) => s.destination.name },
    {
      id: 'verified',
      header: t('bk.verified'),
      accessorFn: (s) => s.verified_at ?? '',
      cell: ({ row }) => <VerifyBadge s={row.original} />,
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          size="sm"
          variant={verifyState(row.original) === 'verified' ? 'ghost' : 'outline'}
          onClick={() => verify.mutate(row.original)}
          aria-label={t('bk.verifyFor', { name: row.original.hosting_account?.username ?? '' })}
        >
          {t('bk.verifyNow')}
        </Button>
      ),
    },
  ];
  return (
    <div className="flex flex-col gap-6">
      <ListPage<Snapshot>
        embedded
        title={t('bk.tabs.verify')}
        description={t('bk.verifyHint', { days: VERIFY_WINDOW_DAYS })}
        queryKey={['admin', 'backups', 'snapshots', 'latest']}
        fetch={async (q) => latestPerAccount(await list('/api/v1/admin/backup-snapshots', q))}
        columns={columns}
        getRowId={(s) => s.uuid}
        primaryColumnId="account"
      />
      <VerificationHistory />
    </div>
  );
}

type Verification = Row<'/api/v1/admin/backup-verifications'>;

/** Lịch sử kiểm chứng: `restic check` hằng tuần (đọc 5 % dữ liệu) và restore test hằng tháng (D-87). */
function VerificationHistory() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const columns: ColumnDef<Verification, unknown>[] = [
    {
      id: 'kind',
      header: t('bk.vh.kind'),
      accessorKey: 'kind',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{t(`bk.vh.kinds.${row.original.kind}`)}</p>
          <p className="text-sm text-muted">
            {row.original.destination.name}
            {row.original.hosting_account && ` · ${row.original.hosting_account.username}`}
          </p>
        </div>
      ),
    },
    {
      id: 'state',
      header: t('bk.vh.state'),
      accessorKey: 'state',
      cell: ({ row }) => <StatusBadge status={row.original.state} />,
    },
    {
      id: 'result',
      header: t('bk.vh.result'),
      accessorFn: (v) => v.mismatches,
      cell: ({ row }) => {
        const v = row.original;
        return (
          <div className="flex max-w-md flex-col items-start gap-1 text-sm">
            {v.read_data_percent !== null && (
              <span>{t('bk.vh.readData', { pct: v.read_data_percent })}</span>
            )}
            {v.files_checked !== null && (
              <span>{t('bk.vh.files', { count: v.files_checked })}</span>
            )}
            {v.mismatches > 0 && (
              <Badge tone="danger">{t('bk.vh.mismatches', { count: v.mismatches })}</Badge>
            )}
            {v.error && <span className="text-danger-text">{v.error}</span>}
          </div>
        );
      },
    },
    {
      id: 'at',
      header: t('bk.vh.at'),
      accessorKey: 'started_at',
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{fmt.dateTime(row.original.started_at)}</span>
      ),
    },
  ];
  return (
    <ListPage<Verification>
      embedded
      title={t('bk.vh.title')}
      description={t('bk.vh.hint')}
      queryKey={['admin', 'backups', 'verifications']}
      fetch={(q) => list('/api/v1/admin/backup-verifications', q)}
      columns={columns}
      getRowId={(v) => v.uuid}
      primaryColumnId="kind"
    />
  );
}
