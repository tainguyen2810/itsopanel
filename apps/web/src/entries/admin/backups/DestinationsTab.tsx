import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { useSession } from '@/shared/session/SessionContext';
import { SelectField, SwitchField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { Alert } from '@/ui/Alert';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { Mono, RowMenu } from '@/shared/hosting/pages/common';
import { DEST_FIELDS, destBody, destSchema, type DestForm, type DestType } from './forms';

type Dest = Row<'/api/v1/admin/backup-destinations'>;
const TYPES = Object.keys(DEST_FIELDS) as DestType[];

/** Tóm tắt cấu hình đích không chứa bí mật (credentials không bao giờ được trả về). */
const summary = (d: Dest) =>
  d.config.bucket ?? d.config.host ?? d.config.url ?? d.config.path ?? '';

export function DestinationsTab() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { user } = useSession();
  const sa = user.role === 'SUPER_ADMIN';
  const [editing, setEditing] = useState<Dest | 'new' | null>(null);
  const test = useAction((d: Dest) =>
    send('POST', '/api/v1/admin/backup-destinations/{id}:test', { path: { id: d.uuid } }),
  );
  const columns: ColumnDef<Dest, unknown>[] = [
    {
      id: 'name',
      header: t('bk.destination'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{row.original.name}</p>
          <Mono>{summary(row.original)}</Mono>
        </div>
      ),
    },
    {
      id: 'type',
      header: t('bk.type'),
      accessorKey: 'type',
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          <Badge tone="neutral">{t(`bk.types.${row.original.type}`)}</Badge>
          {row.original.type !== 'local' && <Badge tone="info">{t('bk.offsite')}</Badge>}
        </span>
      ),
    },
    {
      id: 'protect',
      header: t('bk.protection'),
      accessorFn: (d) => (d.immutable_days ?? 0) + (d.append_only ? 1 : 0),
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          {row.original.immutable_days ? (
            <Badge tone="success">
              {t('bk.immutableDays', { count: row.original.immutable_days })}
            </Badge>
          ) : null}
          {row.original.append_only && <Badge tone="success">{t('bk.appendOnly')}</Badge>}
          {!row.original.immutable_days && !row.original.append_only && (
            <span className="text-muted">—</span>
          )}
        </span>
      ),
    },
    {
      id: 'used',
      header: t('bk.used'),
      accessorKey: 'used_mb',
      cell: ({ row }) => <span className="tabular-nums">{fmt.mb(row.original.used_mb)}</span>,
    },
    {
      id: 'check',
      header: t('bk.lastCheck'),
      accessorFn: (d) => d.last_check_at ?? '',
      cell: ({ row }) =>
        row.original.last_check_at === null ? (
          <Badge tone="neutral">{t('bk.notChecked')}</Badge>
        ) : (
          <span className="flex flex-col items-start gap-1">
            <Badge tone={row.original.last_check_ok ? 'success' : 'danger'}>
              {row.original.last_check_ok ? t('bk.checkOk') : t('bk.checkFail')}
            </Badge>
            <span className="text-sm text-muted">{fmt.rel(row.original.last_check_at)}</span>
          </span>
        ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) =>
        sa ? (
          <RowMenu
            label={t('bk.destActions', { name: row.original.name })}
            actions={[
              { label: t('bk.test'), onSelect: () => test.mutate(row.original) },
              { label: t('bk.edit'), onSelect: () => setEditing(row.original) },
            ]}
          />
        ) : null,
    },
  ];
  return (
    <>
      <ListPage<Dest>
        embedded
        title={t('bk.tabs.destinations')}
        description={t('bk.destinationsHint')}
        actions={
          sa ? (
            <Button onClick={() => setEditing('new')}>
              <Plus aria-hidden />
              {t('bk.addDest')}
            </Button>
          ) : undefined
        }
        queryKey={['admin', 'backups', 'destinations', 'list']}
        fetch={(q) => list('/api/v1/admin/backup-destinations', q)}
        columns={columns}
        getRowId={(d) => d.uuid}
        primaryColumnId="name"
      />
      {editing && (
        <DestDialog dest={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function DestDialog({ dest, onClose }: { dest: Dest | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const c = dest?.config ?? {};
  const { control, handleSubmit } = useForm<DestForm>({
    resolver: zodResolver(destSchema),
    defaultValues: {
      name: dest?.name ?? '',
      type: dest?.type ?? 's3',
      path: c.path ?? '',
      host: c.host ?? '',
      endpoint: c.endpoint ?? '',
      bucket: c.bucket ?? '',
      region: c.region ?? '',
      url: c.url ?? '',
      password: '',
      access_key: '',
      secret_key: '',
      append_only: dest?.append_only ?? false,
      immutable: (dest?.immutable_days ?? 0) > 0,
      ...(dest?.immutable_days ? { immutable_days: dest.immutable_days } : { immutable_days: 30 }),
    },
  });
  const type = useWatch({ control, name: 'type' });
  const immutable = useWatch({ control, name: 'immutable' });
  const save = useAction(
    (v: DestForm) => {
      const body = destBody(v);
      if (!dest) return send('POST', '/api/v1/admin/backup-destinations', { body });
      const { type: _type, ...patch } = body;
      void _type;
      return send('PATCH', '/api/v1/admin/backup-destinations/{id}', {
        path: { id: dest.uuid },
        body: patch,
        headers: { 'If-Match': `"${dest.updated_at}"` },
      });
    },
    { success: t('bk.destSaved'), invalidate: [['admin', 'backups']], onSuccess: onClose },
  );
  const fields = DEST_FIELDS[type];
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={dest ? t('bk.editDest', { name: dest.name }) : t('bk.addDest')}
      description={t('bk.destFormHint')}
      submitLabel={t('bk.save')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      <TextField control={control} name="name" label={t('bk.destName')} />
      {!dest && (
        <SelectField
          control={control}
          name="type"
          label={t('bk.type')}
          options={TYPES.map((k) => ({ value: k, label: t(`bk.types.${k}`) }))}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.config.map((k) => (
          <TextField
            key={k}
            control={control}
            name={k}
            label={t(`bk.cfg.${k}`)}
            optional={k === 'region'}
            {...(k === 'endpoint' || k === 'url' ? { type: 'url' as const } : {})}
          />
        ))}
        {fields.secret.map((k) => (
          <TextField
            key={k}
            control={control}
            name={k}
            type="password"
            autoComplete="new-password"
            label={t(`bk.cfg.${k}`)}
            {...(dest ? { description: t('bk.keepSecret'), optional: true } : {})}
          />
        ))}
      </div>
      <SwitchField
        control={control}
        name="append_only"
        label={t('bk.appendOnly')}
        description={t('bk.appendOnlyHint')}
      />
      {type === 's3' && (
        <>
          <SwitchField
            control={control}
            name="immutable"
            label={t('bk.objectLock')}
            description={t('bk.objectLockHint')}
          />
          {immutable && (
            <TextField
              control={control}
              name="immutable_days"
              type="number"
              inputMode="numeric"
              label={t('bk.immutableDaysLabel')}
            />
          )}
        </>
      )}
      {dest?.immutable_days ? (
        <Alert tone="info" title={t('bk.lockNote', { count: dest.immutable_days })} />
      ) : null}
    </FormDialog>
  );
}
