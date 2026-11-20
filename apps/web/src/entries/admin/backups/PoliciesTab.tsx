import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { useSession } from '@/shared/session/SessionContext';
import { parseCron } from '@/shared/hosting/cron';
import { CheckGroupField, SelectField, SwitchField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { useCronText } from '../sites/CronPage';
import { Mono, RowMenu, useActiveAccounts } from '../sites/common';
import { policySchema, type PolicyForm } from './forms';

type Policy = Row<'/api/v1/admin/backup-policies'>;
const SCOPES = ['all_accounts', 'hosting_account', 'server', 'panel'] as const;

export function PoliciesTab() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const cron = useCronText();
  const { user } = useSession();
  const sa = user.role === 'SUPER_ADMIN';
  const [editing, setEditing] = useState<Policy | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Policy | null>(null);
  const dests = useQuery({
    queryKey: ['admin', 'backups', 'destinations'],
    queryFn: () => list('/api/v1/admin/backup-destinations'),
  });
  const destName = (id: string) => dests.data?.find((d) => d.uuid === id)?.name ?? id.slice(-6);
  const run = useAction((p: Policy) =>
    send('POST', '/api/v1/admin/backup-policies/{id}:run', { path: { id: p.uuid } }),
  );
  const remove = useAction(
    (p: Policy) => send('DELETE', '/api/v1/admin/backup-policies/{id}', { path: { id: p.uuid } }),
    {
      success: t('bk.policyDeleted'),
      invalidate: [['admin', 'backups']],
      onSuccess: () => setDeleting(null),
    },
  );
  const columns: ColumnDef<Policy, unknown>[] = [
    {
      id: 'name',
      header: t('bk.policy'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{row.original.name}</p>
          <p className="text-sm text-muted">{t(`bk.scope.${row.original.scope_type}`)}</p>
        </div>
      ),
    },
    {
      id: 'schedule',
      header: t('bk.schedule'),
      accessorKey: 'schedule',
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span>{cron(row.original.schedule)}</span>
          <Mono>{row.original.schedule}</Mono>
        </div>
      ),
    },
    {
      id: 'dests',
      header: t('bk.destinations'),
      accessorFn: (p) => p.destination_uuids.length,
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          {row.original.destination_uuids.map((id) => (
            <Badge key={id} tone="neutral">
              {destName(id)}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      id: 'retention',
      header: t('bk.retention'),
      accessorFn: (p) => JSON.stringify(p.retention),
      cell: ({ row }) => (
        <span className="text-sm">
          {Object.entries(row.original.retention)
            .map(([k, n]) => t(`bk.keep.${k}` as never, { count: n }))
            .join(' · ')}
        </span>
      ),
    },
    {
      id: 'last',
      header: t('bk.lastRun'),
      accessorFn: (p) => p.last_run_at ?? '',
      cell: ({ row }) =>
        row.original.last_run_at ? (
          <span className="flex flex-col items-start gap-1">
            {row.original.last_status && <StatusBadge status={row.original.last_status} />}
            <span className="text-sm text-muted">{fmt.rel(row.original.last_run_at)}</span>
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'enabled',
      header: t('bk.enabled'),
      accessorFn: (p) => (p.enabled ? 1 : 0),
      cell: ({ row }) =>
        row.original.enabled ? (
          <Badge tone="success">{t('sites.on')}</Badge>
        ) : (
          <Badge tone="neutral">{t('sites.off')}</Badge>
        ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) =>
        sa ? (
          <RowMenu
            label={t('bk.policyActions', { name: row.original.name })}
            actions={[
              { label: t('bk.runNow'), onSelect: () => run.mutate(row.original) },
              { label: t('bk.edit'), onSelect: () => setEditing(row.original) },
              { label: t('bk.delete'), onSelect: () => setDeleting(row.original), danger: true },
            ]}
          />
        ) : null,
    },
  ];
  return (
    <>
      <ListPage<Policy>
        embedded
        title={t('bk.tabs.policies')}
        description={t('bk.policiesHint')}
        actions={
          sa ? (
            <Button onClick={() => setEditing('new')}>
              <Plus aria-hidden />
              {t('bk.addPolicy')}
            </Button>
          ) : undefined
        }
        queryKey={['admin', 'backups', 'policies']}
        fetch={(q) => list('/api/v1/admin/backup-policies', q)}
        columns={columns}
        getRowId={(p) => p.uuid}
        primaryColumnId="name"
      />
      {editing && (
        <PolicyDialog
          policy={editing === 'new' ? null : editing}
          dests={(dests.data ?? []).map((d) => ({ value: d.uuid, label: d.name }))}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('bk.deletePolicy', { name: deleting?.name ?? '' })}
        description={t('bk.deletePolicyHint')}
        confirmLabel={t('bk.delete')}
        onConfirm={() =>
          deleting ? remove.mutateAsync(deleting).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function PolicyDialog({
  policy,
  dests,
  onClose,
}: {
  policy: Policy | null;
  dests: { value: string; label: string }[];
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const cron = useCronText();
  const { options: accounts } = useActiveAccounts();
  const servers = useQuery({
    queryKey: ['admin', 'servers', 'options'],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const { control, handleSubmit } = useForm<PolicyForm>({
    resolver: zodResolver(policySchema),
    defaultValues: {
      name: policy?.name ?? '',
      scope_type: policy?.scope_type ?? 'all_accounts',
      scope_uuid: policy?.scope_uuid ?? '',
      schedule: policy?.schedule ?? '0 1 * * *',
      destination_uuids: policy?.destination_uuids ?? [],
      daily: policy?.retention.daily ?? 7,
      weekly: policy?.retention.weekly ?? 4,
      monthly: policy?.retention.monthly ?? 3,
      enabled: policy?.enabled ?? true,
    },
  });
  const scope = useWatch({ control, name: 'scope_type' });
  const schedule = useWatch({ control, name: 'schedule' });
  const save = useAction(
    (v: PolicyForm) => {
      const body = {
        name: v.name,
        scope_type: v.scope_type,
        scope_uuid:
          v.scope_type === 'server' || v.scope_type === 'hosting_account' ? v.scope_uuid : null,
        schedule: v.schedule,
        destination_uuids: v.destination_uuids,
        retention: Object.fromEntries(
          (['daily', 'weekly', 'monthly'] as const).filter((k) => v[k] > 0).map((k) => [k, v[k]]),
        ),
        enabled: v.enabled,
      };
      return policy
        ? send('PATCH', '/api/v1/admin/backup-policies/{id}', {
            path: { id: policy.uuid },
            body,
            headers: { 'If-Match': `"${policy.updated_at}"` },
          })
        : send('POST', '/api/v1/admin/backup-policies', { body });
    },
    { success: t('bk.policySaved'), invalidate: [['admin', 'backups']], onSuccess: onClose },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={policy ? t('bk.editPolicy', { name: policy.name }) : t('bk.addPolicy')}
      description={t('bk.policyFormHint')}
      submitLabel={t('bk.save')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      <TextField control={control} name="name" label={t('bk.policyName')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="scope_type"
          label={t('bk.scopeLabel')}
          options={SCOPES.map((s) => ({ value: s, label: t(`bk.scope.${s}`) }))}
        />
        {scope === 'server' && (
          <SelectField
            control={control}
            name="scope_uuid"
            label={t('sites.server')}
            options={(servers.data ?? []).map((s) => ({ value: s.uuid, label: s.name }))}
            placeholder={t('bk.pickServer')}
          />
        )}
        {scope === 'hosting_account' && (
          <SelectField
            control={control}
            name="scope_uuid"
            label={t('sites.account')}
            options={accounts}
            placeholder={t('sites.pickAccount')}
          />
        )}
      </div>
      <TextField
        control={control}
        name="schedule"
        label={t('bk.schedule')}
        description={parseCron(schedule ?? '').ok ? cron(schedule ?? '') : t('bk.scheduleHint')}
      />
      <CheckGroupField
        control={control}
        name="destination_uuids"
        label={t('bk.destinations')}
        options={dests}
      />
      <fieldset>
        <legend className="mb-2 text-base font-medium">{t('bk.retention')}</legend>
        <div className="grid grid-cols-3 gap-3">
          <TextField
            control={control}
            name="daily"
            type="number"
            inputMode="numeric"
            label={t('bk.daily')}
          />
          <TextField
            control={control}
            name="weekly"
            type="number"
            inputMode="numeric"
            label={t('bk.weekly')}
          />
          <TextField
            control={control}
            name="monthly"
            type="number"
            inputMode="numeric"
            label={t('bk.monthly')}
          />
        </div>
      </fieldset>
      <SwitchField control={control} name="enabled" label={t('bk.enabled')} />
    </FormDialog>
  );
}
