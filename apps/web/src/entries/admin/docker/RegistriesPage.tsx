import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, PlugZap, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useFmt } from '@/shared/format/useFmt';
import { TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { useSession } from '@/shared/session/SessionContext';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';

type Registry = Row<'/api/v1/admin/registries'>;
const KEY = ['admin', 'registries'];

export const registrySchema = z.object({
  name: z.string().min(1, 'form.required').max(80, 'form.invalid'),
  url: z.string().regex(/^https:\/\/[^\s/]+/, 'admin:registries.errors.url'),
  username: z.string(),
  password: z.string(),
});
type Form = z.infer<typeof registrySchema>;

export default function RegistriesPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { user } = useSession();
  const sa = user.role === 'SUPER_ADMIN';
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Registry | null>(null);
  const remove = useAction(
    (r: Registry) => send('DELETE', '/api/v1/admin/registries/{id}', { path: { id: r.uuid } }),
    { success: t('registries.removed'), invalidate: [KEY], onSuccess: () => setRemoving(null) },
  );
  const test = useAction(
    (r: Registry) => send('POST', '/api/v1/admin/registries/{id}:test', { path: { id: r.uuid } }),
    { invalidate: [KEY] },
  );
  const columns: ColumnDef<Registry, unknown>[] = [
    {
      id: 'name',
      header: t('registries.name'),
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      id: 'url',
      header: 'URL',
      accessorKey: 'url',
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.url}</span>,
    },
    { id: 'username', header: t('registries.username'), accessorFn: (r) => r.username ?? '—' },
    {
      id: 'test',
      header: t('registries.lastTest'),
      accessorFn: (r) => r.last_test?.at ?? '',
      cell: ({ row }) => {
        const lt = row.original.last_test;
        return lt ? (
          <span className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5">
              <Badge tone={lt.ok ? 'success' : 'danger'}>
                {lt.ok ? t('registries.testOk') : t('registries.testFail')}
              </Badge>
              <span className="text-xs text-muted">{fmt.rel(lt.at)}</span>
            </span>
            {!lt.ok && <span className="text-sm text-danger-text">{lt.message}</span>}
          </span>
        ) : (
          <span className="text-muted">{t('registries.notTested')}</span>
        );
      },
    },
    { id: 'created', header: t('docker.created'), accessorFn: (r) => fmt.date(r.created_at) },
    ...(sa
      ? [
          {
            id: 'remove',
            header: t('servers.actions'),
            enableSorting: false,
            cell: ({ row }) => (
              <span className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('registries.test', { name: row.original.name })}
                  disabled={test.isPending}
                  onClick={() => test.mutate(row.original)}
                >
                  <PlugZap aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('registries.remove', { name: row.original.name })}
                  onClick={() => setRemoving(row.original)}
                >
                  <Trash2 aria-hidden />
                </Button>
              </span>
            ),
          } satisfies ColumnDef<Registry, unknown>,
        ]
      : []),
  ];
  return (
    <>
      <ListPage<Registry>
        title={t('registries.title')}
        description={t('registries.description')}
        actions={
          sa ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('registries.add')}
            </Button>
          ) : undefined
        }
        queryKey={KEY}
        fetch={() => list('/api/v1/admin/registries')}
        columns={columns}
        getRowId={(r) => r.uuid}
        primaryColumnId="name"
        search={false}
      />
      {sa && <AddRegistry open={creating} onOpenChange={setCreating} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('registries.removeTitle', { name: removing?.name ?? '' })}
        description={t('registries.removeHint')}
        confirmLabel={t('registries.removeConfirm')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function AddRegistry({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit, reset } = useForm<Form>({
    resolver: zodResolver(registrySchema),
    defaultValues: { name: '', url: 'https://', username: '', password: '' },
  });
  const add = useAction(
    (v: Form) =>
      send('POST', '/api/v1/admin/registries', {
        body: {
          name: v.name,
          url: v.url,
          username: v.username || null,
          password: v.password || null,
        },
      }),
    {
      success: t('registries.added'),
      invalidate: [KEY],
      onSuccess: () => {
        reset();
        onOpenChange(false);
      },
    },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('registries.addTitle')}
      description={t('registries.addHint')}
      pending={add.isPending}
      onSubmit={() => void handleSubmit((v) => add.mutate(v))()}
    >
      <TextField control={control} name="name" label={t('registries.name')} />
      <TextField
        control={control}
        name="url"
        type="url"
        label="URL"
        placeholder="https://ghcr.io"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          control={control}
          name="username"
          label={t('registries.username')}
          optional
          autoComplete="off"
        />
        <TextField
          control={control}
          name="password"
          type="password"
          label={t('registries.password')}
          optional
          autoComplete="new-password"
        />
      </div>
    </FormDialog>
  );
}
