import { useState } from 'react';
import { ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { ProgressBar } from '@/ui/ProgressBar';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { daysLeft, purgeStage, type Purge } from './accounts';

type Account = Row<'/api/v1/admin/hosting-accounts'>;
interface Item {
  a: Account;
  purge: Purge | undefined;
  snapshot: Row<'/api/v1/admin/backup-snapshots'> | undefined;
}

/** Tài khoản đã chấm dứt: giữ dữ liệu ≥ 30 ngày, backup cuối đã kiểm chứng, purge 2 bước (D-46). */
export default function TerminatedPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { user } = useSession();
  const [act, setAct] = useState<{ kind: 'schedule' | 'confirm'; item: Item } | null>(null);
  const inv = [
    ['admin', 'terminated'],
    ['admin', 'purges'],
    ['admin', 'accounts'],
  ];
  const schedule = useAction(
    (id: string) =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:schedule-purge', {
        path: { id },
        body: { final_backup: true },
      }),
    { invalidate: inv },
  );
  const confirm = useAction(
    (v: { id: string; purge: string; username: string }) =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:confirm-purge', {
        path: { id: v.id },
        body: { purge_uuid: v.purge, confirm_username: v.username },
      }),
    { invalidate: inv },
  );

  const columns: ColumnDef<Item, unknown>[] = [
    {
      id: 'username',
      header: t('accounts.username'),
      accessorFn: (i) => i.a.username,
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/hosting-accounts/${row.original.a.uuid}`}
            className="font-mono font-medium hover:underline"
          >
            {row.original.a.username}
          </AppLink>
          <p className="text-sm text-muted">
            {row.original.a.owner.name} · {row.original.a.server.name}
          </p>
        </div>
      ),
    },
    {
      id: 'terminated',
      header: t('terminated.terminatedAt'),
      accessorFn: (i) => fmt.opt(i.a.terminated_at),
    },
    {
      id: 'left',
      header: t('terminated.countdown'),
      accessorFn: (i) => daysLeft(i.a.purge_after) ?? 0,
      cell: ({ row, getValue }) => {
        const left = getValue<number>();
        const total = 30;
        return (
          <div className="flex w-36 flex-col gap-1">
            <span className="text-sm tabular-nums">
              {t('terminated.daysLeft', { count: left })}
            </span>
            <ProgressBar
              label={t('terminated.countdownOf', { name: row.original.a.username })}
              value={Math.max(0, Math.min(100, ((total - left) * 100) / total))}
              thresholds={{ warn: 70, danger: 90 }}
            />
            <span className="text-xs text-muted">{fmt.opt(row.original.a.purge_after)}</span>
          </div>
        );
      },
    },
    {
      id: 'backup',
      header: t('terminated.finalBackup'),
      accessorFn: (i) => i.purge?.backup_verified_at ?? i.snapshot?.verified_at ?? '',
      cell: ({ row }) => {
        const at = row.original.purge?.backup_verified_at ?? row.original.snapshot?.verified_at;
        return at ? (
          <div className="flex flex-col items-start gap-1">
            <StatusBadge status="verified" />
            <span className="text-xs text-muted">{fmt.dateTime(at)}</span>
          </div>
        ) : (
          <StatusBadge status="pending" />
        );
      },
    },
    {
      id: 'stage',
      header: t('terminated.stage'),
      accessorFn: (i) => (i.a.legal_hold ? 'hold' : purgeStage(i.purge)),
      cell: ({ row, getValue }) => {
        const st = getValue<string>();
        const p = row.original.purge;
        return (
          <div className="flex flex-col items-start gap-1">
            <Badge tone={st === 'hold' ? 'danger' : st === 'scheduled' ? 'warning' : 'neutral'}>
              {t(`terminated.stages.${st}` as never)}
            </Badge>
            {p && (
              <span className="text-xs text-muted">
                {t('terminated.requestedBy', { name: p.requested_by.name })}
                {p.confirmed_by &&
                  ` · ${t('terminated.confirmedBy', { name: p.confirmed_by.name })}`}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: t('terminated.actions'),
      enableSorting: false,
      cell: ({ row }) => {
        const i = row.original;
        const st = purgeStage(i.purge);
        if (i.a.legal_hold) return null;
        if (st === 'none') {
          return (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAct({ kind: 'schedule', item: i })}
            >
              <Trash2 aria-hidden />
              {t('terminated.schedule')}
            </Button>
          );
        }
        if (st === 'backup') {
          // D-87: chưa có snapshot cuối đã kiểm chứng khôi phục được → chưa xác nhận purge được.
          return (
            <div className="flex flex-col items-start gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled
                aria-describedby={`purge-block-${i.a.uuid}`}
              >
                <ShieldCheck aria-hidden />
                {t('terminated.confirm')}
              </Button>
              <span id={`purge-block-${i.a.uuid}`} className="max-w-48 text-xs text-muted">
                {t('terminated.needVerified')}
              </span>
            </div>
          );
        }
        // Như API thật: chỉ xác nhận được sau hạn giữ dữ liệu; xác nhận xong purge chạy ngay.
        const due = [i.purge?.scheduled_for, i.a.purge_after].find(
          (d) => d && Date.parse(d) > Date.now(),
        );
        if (st === 'confirm' && due) {
          return (
            <div className="flex flex-col items-start gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled
                aria-describedby={`purge-due-${i.a.uuid}`}
              >
                <ShieldCheck aria-hidden />
                {t('terminated.confirm')}
              </Button>
              <span id={`purge-due-${i.a.uuid}`} className="max-w-48 text-xs text-muted">
                {t('terminated.notDue', { date: fmt.opt(due) })}
              </span>
            </div>
          );
        }
        if (st === 'confirm') {
          return (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAct({ kind: 'confirm', item: i })}
            >
              <ShieldCheck aria-hidden />
              {t('terminated.confirm')}
            </Button>
          );
        }
        return null;
      },
    },
  ];

  const selfRequested = act?.kind === 'confirm' && act.item.purge?.requested_by.uuid === user.uuid;
  return (
    <>
      <ListPage<Item>
        title={t('terminated.title')}
        description={t('terminated.description')}
        queryKey={['admin', 'terminated']}
        fetch={async (q) => {
          const [accounts, snaps, recs] = await Promise.all([
            list('/api/v1/admin/hosting-accounts', {
              ...q,
              filters: { lifecycle_state: 'terminated' },
            }),
            list('/api/v1/admin/backup-snapshots'),
            list('/api/v1/admin/purge-records'),
          ]);
          return accounts.map((a) => ({
            a,
            purge: recs.find((p) => p.hosting_account.uuid === a.uuid && !p.completed_at),
            snapshot: snaps.find((s) => s.hosting_account?.uuid === a.uuid && s.verified_at),
          }));
        }}
        columns={columns}
        getRowId={(i) => i.a.uuid}
        primaryColumnId="username"
        empty={<p className="p-6 text-center text-base text-muted">{t('terminated.empty')}</p>}
      >
        <Alert tone="info" title={t('terminated.policyTitle')} className="mb-4">
          {t('terminated.policy')}
        </Alert>
      </ListPage>
      <ConfirmDialog
        open={act?.kind === 'schedule'}
        onOpenChange={(o) => !o && setAct(null)}
        title={t('terminated.scheduleTitle', { name: act?.item.a.username ?? '' })}
        description={t('terminated.scheduleHint', { date: fmt.opt(act?.item.a.purge_after) })}
        confirmLabel={t('terminated.schedule')}
        onConfirm={() => schedule.mutateAsync(act?.item.a.uuid ?? '').then(() => setAct(null))}
      />
      <ConfirmDialog
        open={act?.kind === 'confirm' && !selfRequested}
        onOpenChange={(o) => !o && setAct(null)}
        title={t('terminated.confirmTitle', { name: act?.item.a.username ?? '' })}
        description={t('terminated.confirmHint', {
          name: act?.item.purge?.requested_by.name ?? '',
          date: fmt.opt(act?.item.purge?.scheduled_for),
        })}
        confirmName={act?.item.a.username ?? ''}
        confirmLabel={t('terminated.confirm')}
        onConfirm={() =>
          confirm
            .mutateAsync({
              id: act?.item.a.uuid ?? '',
              purge: act?.item.purge?.uuid ?? '',
              username: act?.item.a.username ?? '',
            })
            .then(() => setAct(null))
        }
      />
      <ConfirmDialog
        open={selfRequested}
        onOpenChange={(o) => !o && setAct(null)}
        tone="primary"
        title={t('terminated.needOtherTitle')}
        description={t('terminated.needOther')}
        confirmLabel={t('terminated.understood')}
        onConfirm={() => setAct(null)}
      />
    </>
  );
}
