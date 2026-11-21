import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SwitchField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Label } from '@/ui/Label';
import { get, list, send, type Data, type Row } from '../api';
import { useAction } from '../useAction';
import { SecurityNav } from './common';
import { jailSchema, type JailForm } from './forms';
import { useSecurityServer } from './useServer';

type F2b = Data<'/api/v1/admin/security/fail2ban'>;
type Jail = F2b['jails'][number];
type Ban = Row<'/api/v1/admin/security/fail2ban/bans'>;

export default function Fail2banPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [editing, setEditing] = useState<Jail | null>(null);
  const { server, picker } = useSecurityServer();
  const q = useQuery({
    queryKey: ['admin', 'security', 'fail2ban', server],
    enabled: server !== '',
    queryFn: () => get('/api/v1/admin/security/fail2ban', { query: { server } }),
  });
  const patch = useAction(
    (body: { enabled?: boolean; jails?: Jail[] }) =>
      send('PATCH', '/api/v1/admin/security/fail2ban', {
        query: { server },
        body,
        headers: q.data ? { 'If-Match': `"${q.data.updated_at}"` } : {},
      }),
    { onSuccess: () => setEditing(null) },
  );
  const columns: ColumnDef<Jail, unknown>[] = [
    {
      id: 'name',
      header: t('sec.jail'),
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
    },
    {
      id: 'enabled',
      header: t('sec.jailState'),
      accessorFn: (j) => (j.enabled ? 1 : 0),
      cell: ({ row }) =>
        row.original.enabled ? (
          <Badge tone="success">{t('sites.on')}</Badge>
        ) : (
          <Badge tone="neutral">{t('sites.off')}</Badge>
        ),
    },
    { id: 'maxretry', header: t('sec.maxretry'), accessorKey: 'maxretry' },
    {
      id: 'findtime',
      header: t('sec.findtime'),
      accessorKey: 'findtime_sec',
      cell: ({ row }) => fmt.duration(row.original.findtime_sec),
    },
    {
      id: 'bantime',
      header: t('sec.bantime'),
      accessorKey: 'bantime_sec',
      cell: ({ row }) => fmt.duration(row.original.bantime_sec),
    },
    {
      id: 'banned',
      header: t('sec.banned'),
      accessorKey: 'banned_count',
      cell: ({ row }) => <span className="tabular-nums">{row.original.banned_count}</span>,
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setEditing(row.original)}
          aria-label={t('sec.editJail', { name: row.original.name })}
        >
          {t('sec.edit')}
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t('sec.f2bTitle')}
        description={t('sec.f2bDescription')}
        actions={picker}
        nav={<SecurityNav current="fail2ban" />}
      />
      {q.isLoading && <PageSkeleton />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
              <div>
                <Label htmlFor="f2b-on" className="text-md font-semibold">
                  {t('sec.f2bEnabled')}
                </Label>
                <p className="text-sm text-muted">
                  {t('sec.updated', { at: fmt.rel(q.data.updated_at) })}
                </p>
              </div>
              <Switch
                id="f2b-on"
                checked={q.data.enabled}
                disabled={patch.isPending}
                onCheckedChange={(v) => patch.mutate({ enabled: v })}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader title={t('sec.jails')} description={t('sec.jailsHint')} />
            <CardContent>
              <DataTable
                data={q.data.jails}
                columns={columns}
                getRowId={(j) => j.name}
                primaryColumnId="name"
                caption={t('sec.jails')}
              />
            </CardContent>
          </Card>
          <BansCard server={server} />
        </div>
      )}
      {editing && (
        <JailDialog
          jail={editing}
          pending={patch.isPending}
          onClose={() => setEditing(null)}
          onSave={(v) => patch.mutate({ jails: [{ ...editing, ...v }] })}
        />
      )}
    </>
  );
}

/** IP đang bị cấm (đọc trực tiếp từ fail2ban qua agent) + gỡ cấm. */
function BansCard({ server }: { server: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const bans = useQuery({
    queryKey: ['admin', 'security', 'fail2ban', 'bans', server],
    queryFn: () => list('/api/v1/admin/security/fail2ban/bans', { filters: { server } }),
  });
  const unban = useAction(
    (b: Ban) =>
      send('POST', '/api/v1/admin/security/fail2ban/bans:unban', {
        body: { server: b.server.uuid, jail: b.jail, ip: b.ip },
      }),
    {
      success: t('sec.unbanned'),
      invalidate: [['admin', 'security', 'fail2ban']],
    },
  );
  const columns: ColumnDef<Ban, unknown>[] = [
    {
      id: 'ip',
      header: t('sec.ip'),
      accessorKey: 'ip',
      cell: ({ row }) => <span className="font-mono">{row.original.ip}</span>,
    },
    {
      id: 'jail',
      header: t('sec.jail'),
      accessorKey: 'jail',
      cell: ({ row }) => <span className="font-mono">{row.original.jail}</span>,
    },
    {
      id: 'banned_at',
      header: t('sec.bannedAt'),
      accessorKey: 'banned_at',
      cell: ({ row }) => fmt.rel(row.original.banned_at),
    },
    {
      id: 'expires_at',
      header: t('sec.expiresAt'),
      accessorFn: (b) => b.expires_at ?? '',
      cell: ({ row }) =>
        row.original.expires_at ? fmt.rel(row.original.expires_at) : t('sec.banPermanent'),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          disabled={unban.isPending}
          onClick={() => unban.mutate(row.original)}
          aria-label={t('sec.unbanFor', { ip: row.original.ip })}
        >
          {t('sec.unban')}
        </Button>
      ),
    },
  ];
  return (
    <Card>
      <CardHeader title={t('sec.bans')} description={t('sec.bansHint')} />
      <CardContent>
        {bans.error ? (
          <ErrorState error={bans.error} onRetry={() => void bans.refetch()} />
        ) : (
          <DataTable
            data={bans.data ?? []}
            columns={columns}
            getRowId={(b) => `${b.jail}:${b.ip}`}
            primaryColumnId="ip"
            caption={t('sec.bans')}
            empty={t('sec.bansEmpty')}
          />
        )}
      </CardContent>
    </Card>
  );
}

function JailDialog({
  jail,
  pending,
  onClose,
  onSave,
}: {
  jail: Jail;
  pending: boolean;
  onClose: () => void;
  onSave: (v: JailForm) => void;
}) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit } = useForm<JailForm>({
    resolver: zodResolver(jailSchema),
    defaultValues: jail,
  });
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('sec.editJail', { name: jail.name })}
      submitLabel={t('sec.apply')}
      pending={pending}
      onSubmit={() => void handleSubmit(onSave)()}
    >
      <SwitchField control={control} name="enabled" label={t('sec.jailState')} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          control={control}
          name="maxretry"
          type="number"
          inputMode="numeric"
          label={t('sec.maxretry')}
        />
        <TextField
          control={control}
          name="findtime_sec"
          type="number"
          inputMode="numeric"
          label={t('sec.findtimeSec')}
        />
        <TextField
          control={control}
          name="bantime_sec"
          type="number"
          inputMode="numeric"
          label={t('sec.bantimeSec')}
        />
      </div>
    </FormDialog>
  );
}
