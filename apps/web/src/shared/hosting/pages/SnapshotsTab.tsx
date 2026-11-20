import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, File, Folder, HardDriveUpload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { CheckboxField, SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { CodeBlock } from '@/ui/CodeBlock';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { get, list, send, type Row } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { Mono, RowMenu, useAccountFilter, useActiveAccounts, type RowAction } from './common';
import { backupNowSchema, type BackupNowForm } from '../backup';
import { VerifyBadge, type Snapshot } from './backup';

type Entry = Row<'/backup-snapshots/{id}/browse'>;

/**
 * Lịch sử snapshot (Admin và Portal): backup ngay, duyệt, tạo link tải, khôi phục. Thao tác chỉ
 * Admin có (kiểm chứng, xóa) truyền qua `extraActions`.
 */
export function SnapshotsTab({
  onRestore,
  extraActions,
}: {
  onRestore: (s: Snapshot) => void;
  extraActions?: (s: Snapshot) => RowAction[];
}) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const accountFilter = useAccountFilter();
  const [backingUp, setBackingUp] = useState(false);
  const [browsing, setBrowsing] = useState<Snapshot | null>(null);
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null);
  const download = useAction(
    (s: Snapshot) =>
      send<{ url: string; expires_at: string }>('POST', '/backup-snapshots/{id}:download-link', {
        path: { id: s.uuid },
      }),
    { onSuccess: (r) => setLink(r) },
  );
  const columns: ColumnDef<Snapshot, unknown>[] = [
    {
      id: 'account',
      header: t('sites.account'),
      accessorFn: (s) => s.hosting_account?.username ?? t('bk.panel'),
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{row.original.hosting_account?.username ?? t('bk.panel')}</p>
          <p className="text-sm text-muted">
            <Mono>{row.original.restic_snapshot_id}</Mono>
          </p>
        </div>
      ),
    },
    {
      id: 'taken',
      header: t('bk.taken'),
      accessorKey: 'taken_at',
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{fmt.dateTime(row.original.taken_at)}</span>
      ),
    },
    { id: 'dest', header: t('bk.destination'), accessorFn: (s) => s.destination.name },
    {
      id: 'size',
      header: t('bk.size'),
      accessorKey: 'size_mb',
      cell: ({ row }) => <span className="tabular-nums">{fmt.mb(row.original.size_mb)}</span>,
    },
    {
      id: 'contents',
      header: t('bk.contents'),
      accessorFn: (s) => s.contents.join(','),
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          {row.original.contents.map((c) => (
            <Badge key={c} tone="neutral">
              {t(`bk.content.${c}`)}
            </Badge>
          ))}
          {row.original.tags.map((g) => (
            <Badge key={g} tone="info">
              {g}
            </Badge>
          ))}
        </span>
      ),
    },
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
        <RowMenu
          label={t('bk.actionsFor', { id: row.original.restic_snapshot_id })}
          actions={[
            {
              label: t('bk.restore'),
              onSelect: () => onRestore(row.original),
              hidden: row.original.hosting_account === null,
            },
            { label: t('bk.browse'), onSelect: () => setBrowsing(row.original) },
            { label: t('bk.download'), onSelect: () => download.mutate(row.original) },
            ...(extraActions?.(row.original) ?? []),
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Snapshot>
        embedded
        title={t('bk.tabs.history')}
        description={t('bk.historyHint')}
        actions={
          <Button onClick={() => setBackingUp(true)}>
            <HardDriveUpload aria-hidden />
            {t('bk.backupNow')}
          </Button>
        }
        queryKey={['admin', 'backups', 'snapshots']}
        fetch={(q) => list('/backup-snapshots', q)}
        filters={[accountFilter]}
        columns={columns}
        getRowId={(s) => s.uuid}
        primaryColumnId="account"
      />
      <BackupNowDialog open={backingUp} onOpenChange={setBackingUp} />
      {browsing && <BrowseDialog snapshot={browsing} onClose={() => setBrowsing(null)} />}
      <Dialog open={link !== null} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent
          title={t('bk.linkTitle')}
          description={link ? t('bk.linkHint', { at: fmt.dateTime(link.expires_at) }) : ''}
        >
          <CodeBlock code={link?.url ?? ''} label={t('bk.link')} wrap />
        </DialogContent>
      </Dialog>
    </>
  );
}

function BackupNowDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const { options } = useActiveAccounts(open);
  const empty: BackupNowForm = {
    hosting_account_uuid: '',
    files: true,
    databases: true,
    config: true,
    note: '',
  };
  const { control, handleSubmit, reset, formState } = useForm<BackupNowForm>({
    resolver: zodResolver(backupNowSchema),
    defaultValues: empty,
  });
  const close = (o: boolean) => {
    if (!o) reset(empty);
    onOpenChange(o);
  };
  const run = useAction(
    (v: BackupNowForm) =>
      send('POST', '/backups', {
        body: {
          hosting_account_uuid: v.hosting_account_uuid,
          contents: (['files', 'databases', 'config'] as const).filter((k) => v[k]),
          note: v.note || null,
        },
      }),
    { onSuccess: () => close(false) },
  );
  const contentsError = formState.errors.files?.message;
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t('bk.backupNow')}
      description={t('bk.backupNowHint')}
      submitLabel={t('bk.backupNow')}
      pending={run.isPending}
      onSubmit={() => void handleSubmit((v) => run.mutate(v))()}
    >
      <SelectField
        control={control}
        name="hosting_account_uuid"
        label={t('sites.account')}
        options={options}
        placeholder={t('sites.pickAccount')}
      />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">{t('bk.contents')}</legend>
        <CheckboxField control={control} name="files" label={t('bk.content.files')} />
        <CheckboxField control={control} name="databases" label={t('bk.content.databases')} />
        <CheckboxField control={control} name="config" label={t('bk.content.config')} />
        {contentsError && (
          <p role="alert" className="text-sm text-danger-text">
            {t('bk.errors.contents')}
          </p>
        )}
      </fieldset>
      <TextField control={control} name="note" label={t('bk.note')} optional />
    </FormDialog>
  );
}

/** Duyệt nội dung snapshot (chỉ đọc), điều hướng theo thư mục. */
export function BrowseDialog({ snapshot, onClose }: { snapshot: Snapshot; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [path, setPath] = useState('.');
  const q = useQuery({
    queryKey: ['admin', 'backups', 'browse', snapshot.uuid, path],
    queryFn: () =>
      get('/backup-snapshots/{id}/browse', {
        path: { id: snapshot.uuid },
        query: { path },
      }),
  });
  const parts = path === '.' ? [] : path.split('/');
  const columns: ColumnDef<Entry, unknown>[] = [
    {
      id: 'name',
      header: t('files.name'),
      accessorKey: 'name',
      cell: ({ row }) =>
        row.original.type === 'dir' ? (
          <button
            type="button"
            className="flex items-center gap-2 font-medium hover:underline"
            onClick={() => setPath(row.original.path)}
          >
            <Folder aria-hidden className="size-4 text-primary-text" />
            {row.original.name}
          </button>
        ) : (
          <span className="flex items-center gap-2">
            <File aria-hidden className="size-4 text-muted" />
            {row.original.name}
          </span>
        ),
    },
    {
      id: 'size',
      header: t('bk.size'),
      accessorKey: 'size',
      cell: ({ row }) => (row.original.type === 'dir' ? '—' : fmt.bytes(row.original.size)),
    },
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('bk.browseTitle', { id: snapshot.restic_snapshot_id })}
        description={t('bk.browseHint', { at: fmt.dateTime(snapshot.taken_at) })}
        className="max-w-2xl"
      >
        <nav
          aria-label={t('bk.browsePath')}
          className="mb-2 flex flex-wrap items-center gap-1 text-sm"
        >
          <button type="button" className="hover:underline" onClick={() => setPath('.')}>
            {snapshot.hosting_account?.username ?? t('bk.panel')}
          </button>
          {parts.map((p, i) => (
            <span key={`${p}-${i}`} className="flex items-center gap-1">
              <ChevronRight aria-hidden className="size-3.5 text-muted" />
              <button
                type="button"
                className="hover:underline"
                onClick={() => setPath(parts.slice(0, i + 1).join('/'))}
              >
                {p}
              </button>
            </span>
          ))}
        </nav>
        <DataTable
          data={q.data ?? []}
          columns={columns}
          getRowId={(e) => e.path}
          primaryColumnId="name"
          caption={t('bk.browseTitle', { id: snapshot.restic_snapshot_id })}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Kiểm chứng: snapshot mới nhất của mỗi account phải được restore thử trong 7 ngày. */
