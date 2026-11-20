import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ListPage } from '@/shared/page/ListPage';
import { useSession } from '@/shared/session/SessionContext';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { useFmt } from '@/shared/format/useFmt';
import { VerifyBadge, type Snapshot } from '@/shared/hosting/pages/backup';
import { SnapshotsTab as SharedSnapshotsTab } from '@/shared/hosting/pages/SnapshotsTab';
import { list, send } from '../api';
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
        onRestore={(s) =>
          void navigate({ to: '/restores/new', search: { snapshot: s.uuid } } as never)
        }
        extraActions={(s) => [
          { label: t('bk.verifyNow'), onSelect: () => verify.mutate(s) },
          {
            label: t('bk.delete'),
            onSelect: () => setDeleting(s),
            danger: true,
            hidden: user.role !== 'SUPER_ADMIN',
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
  );
}
