import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Cloud, Globe, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import {
  DNS_PLACEHOLDER,
  DNS_TYPES,
  NEEDS_PRIORITY,
  PROXIABLE,
  dnsRecordSchema,
  type DnsRecordForm,
} from '@/shared/hosting/dns';
import { TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { useUrlState } from '@/shared/page/useUrlState';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { EmptyState } from '@/ui/Feedback';
import { FormField } from '@/ui/FormField';
import { Select } from '@/ui/Select';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { RowMenu } from '@/shared/hosting/pages/common';
import { ProvidersDialog, useIsSuperAdmin, ZoneAccountDialog, ZoneDialog } from './DnsManage';

type Zone = Row<'/api/v1/admin/dns/zones'>;
type Rec = Row<'/api/v1/admin/dns/zones/{id}/records'>;
const TTLS = [60, 300, 3600, 14400, 86400];

export default function DnsPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [url, setUrl] = useUrlState();
  const zones = useQuery({
    queryKey: ['admin', 'dns', 'zones'],
    queryFn: () => list('/api/v1/admin/dns/zones'),
  });
  const zone = zones.data?.find((z) => z.uuid === url.zone) ?? zones.data?.[0];
  const sa = useIsSuperAdmin();
  const [providersOpen, setProvidersOpen] = useState(false);
  const [addingZone, setAddingZone] = useState(false);
  const addZone = (
    <Button size="sm" onClick={() => setAddingZone(true)}>
      <Plus aria-hidden />
      {t('dns.addZone')}
    </Button>
  );
  return (
    <>
      <PageHeader
        title={t('dns.title')}
        description={t('dns.description')}
        actions={
          <div className="flex flex-wrap gap-2">
            {sa && (
              <Button size="sm" variant="secondary" onClick={() => setProvidersOpen(true)}>
                <Cloud aria-hidden />
                {t('dns.providerList')}
              </Button>
            )}
            {addZone}
          </div>
        }
      />
      {sa && <ProvidersDialog open={providersOpen} onOpenChange={setProvidersOpen} />}
      <ZoneDialog
        open={addingZone}
        onOpenChange={setAddingZone}
        onCreated={(z) => setUrl({ zone: z.uuid, q: undefined })}
      />
      {zones.isError ? (
        <ErrorState error={zones.error} onRetry={() => void zones.refetch()} />
      ) : zones.isPending ? (
        <TableSkeleton rows={3} />
      ) : zones.data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={Globe}
              title={t('dns.noZones')}
              description={t('dns.noZonesHint')}
              action={addZone}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <nav aria-label={t('dns.zones')}>
            <ul className="flex flex-col gap-2">
              {zones.data.map((z) => (
                <li key={z.uuid}>
                  <button
                    type="button"
                    onClick={() => setUrl({ zone: z.uuid, q: undefined })}
                    {...(z.uuid === zone?.uuid ? { 'aria-current': 'true' as const } : {})}
                    className="flex w-full flex-col gap-1 rounded-lg border border-border bg-surface p-3 text-left hover:bg-surface-hover aria-[current=true]:border-primary aria-[current=true]:ring-1 aria-[current=true]:ring-primary"
                  >
                    <span className="font-medium break-all">{z.name}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
                      <Badge tone="neutral">{t(`dns.providers.${z.provider}`)}</Badge>
                      {t('dns.recordsCount', { count: z.records_count })}
                    </span>
                    <span className="text-xs text-muted">
                      {z.hosting_account ? z.hosting_account.username : t('dns.system')} ·{' '}
                      {fmt.rel(z.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {zone && (
            <Records
              key={zone.uuid}
              zone={zone}
              onRemoved={() => setUrl({ zone: undefined, q: undefined })}
            />
          )}
        </div>
      )}
    </>
  );
}

function Records({ zone, onRemoved }: { zone: Zone; onRemoved: () => void }) {
  const { t } = useTranslation('admin');
  const [editing, setEditing] = useState<Rec | 'new' | null>(null);
  const [removing, setRemoving] = useState<Rec | null>(null);
  const [zoneAction, setZoneAction] = useState<'account' | 'remove' | null>(null);
  const sync = useAction(
    () => send('POST', '/api/v1/admin/dns/zones/{id}:sync', { path: { id: zone.uuid } }),
    {
      success: t('dns.synced', { name: zone.name }),
      invalidate: [['admin', 'dns']],
    },
  );
  const removeZone = useAction(
    () => send('DELETE', '/api/v1/admin/dns/zones/{id}', { path: { id: zone.uuid } }),
    {
      success: t('dns.zoneRemoved', { name: zone.name }),
      invalidate: [['admin', 'dns', 'zones']],
      onSuccess: () => {
        setZoneAction(null);
        onRemoved();
      },
    },
  );
  const remove = useAction(
    (r: Rec) =>
      send('DELETE', '/api/v1/admin/dns/zones/{id}/records/{record}', {
        path: { id: zone.uuid, record: r.uuid },
      }),
    { onSuccess: () => setRemoving(null) },
  );
  const fqdn = (n: string) => (n === '@' ? zone.name : `${n}.${zone.name}`);
  const columns: ColumnDef<Rec, unknown>[] = [
    {
      id: 'type',
      header: t('dns.type'),
      accessorKey: 'type',
      cell: ({ row }) => <Badge tone="info">{row.original.type}</Badge>,
    },
    {
      id: 'name',
      header: t('dns.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <span className="font-mono text-sm break-all" title={fqdn(row.original.name)}>
          {row.original.name}
        </span>
      ),
    },
    {
      id: 'content',
      header: t('dns.content'),
      accessorKey: 'content',
      cell: ({ row }) => (
        <span className="font-mono text-sm break-all">
          {row.original.priority !== undefined && NEEDS_PRIORITY.includes(row.original.type) && (
            <span className="text-muted">{row.original.priority} </span>
          )}
          {row.original.content}
        </span>
      ),
    },
    {
      id: 'ttl',
      header: 'TTL',
      accessorKey: 'ttl',
      cell: ({ row }) => t('dns.ttlValue', { count: row.original.ttl }),
    },
    ...(zone.provider === 'cloudflare'
      ? [
          {
            id: 'proxied',
            header: 'Proxy',
            accessorFn: (r) => (r.proxied ? 1 : 0),
            cell: ({ row }) =>
              row.original.proxied ? (
                <Badge tone="warning">{t('dns.proxied')}</Badge>
              ) : (
                <span className="text-sm text-muted">{t('dns.dnsOnly')}</span>
              ),
          } satisfies ColumnDef<Rec, unknown>,
        ]
      : []),
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('dns.actionsFor', { name: `${row.original.type} ${row.original.name}` })}
          actions={[
            { label: t('dns.edit'), onSelect: () => setEditing(row.original) },
            {
              label: t('dns.delete'),
              onSelect: () => setRemoving(row.original),
              danger: true,
              hidden: row.original.type === 'NS' && row.original.name === '@',
            },
          ]}
        />
      ),
    },
  ];
  return (
    <div className="min-w-0">
      <ListPage<Rec>
        embedded
        title={t('dns.recordsOf', { name: zone.name })}
        description={zone.provider === 'manual' ? t('dns.manualHint') : t('dns.providerHint')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {zone.provider === 'cloudflare' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => sync.mutate()}
                disabled={sync.isPending}
              >
                <RefreshCw aria-hidden />
                {t('dns.sync')}
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus aria-hidden />
              {t('dns.add')}
            </Button>
            <RowMenu
              label={t('dns.zoneActions', { name: zone.name })}
              actions={[
                { label: t('dns.changeAccount'), onSelect: () => setZoneAction('account') },
                {
                  label: t('dns.removeZone'),
                  onSelect: () => setZoneAction('remove'),
                  danger: true,
                },
              ]}
            />
          </div>
        }
        queryKey={['admin', 'dns', zone.uuid]}
        fetch={(q) => list('/api/v1/admin/dns/zones/{id}/records', q, { path: { id: zone.uuid } })}
        filters={[
          {
            key: 'type',
            label: t('dns.type'),
            options: DNS_TYPES.map((x) => ({ value: x, label: x })),
          },
        ]}
        columns={columns}
        getRowId={(r) => r.uuid}
        primaryColumnId="name"
      />
      {editing && (
        <RecordDialog
          zone={zone}
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('dns.deleteTitle', {
          name: removing ? `${removing.type} ${fqdn(removing.name)}` : '',
        })}
        description={t('dns.deleteHint')}
        confirmLabel={t('dns.delete')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
      {zoneAction === 'account' && (
        <ZoneAccountDialog zone={zone} onClose={() => setZoneAction(null)} />
      )}
      <ConfirmDialog
        open={zoneAction === 'remove'}
        onOpenChange={(o) => !o && setZoneAction(null)}
        title={t('dns.removeZoneTitle', { name: zone.name })}
        description={t('dns.removeZoneHint')}
        confirmLabel={t('dns.removeZone')}
        onConfirm={() => removeZone.mutateAsync().then(() => undefined)}
      />
    </div>
  );
}

export function RecordDialog({
  zone,
  record,
  onClose,
}: {
  zone: Zone;
  record: Rec | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit, setValue } = useForm<DnsRecordForm>({
    resolver: zodResolver(dnsRecordSchema),
    defaultValues: record
      ? {
          type: record.type,
          name: record.name,
          content: record.content,
          ttl: record.ttl,
          proxied: record.proxied,
          ...(record.priority !== undefined ? { priority: record.priority } : {}),
        }
      : { type: 'A', name: '', content: '', ttl: 300, proxied: false },
  });
  const type = useWatch({ control, name: 'type' });
  const cf = zone.provider === 'cloudflare';
  const save = useAction(
    (v: DnsRecordForm) => {
      const body = {
        type: v.type,
        name: v.name,
        content: v.content,
        ttl: v.ttl,
        proxied: cf && PROXIABLE.includes(v.type) ? v.proxied : false,
        ...(NEEDS_PRIORITY.includes(v.type) && v.priority !== undefined
          ? { priority: v.priority }
          : {}),
      };
      return record
        ? send('PATCH', '/api/v1/admin/dns/zones/{id}/records/{record}', {
            path: { id: zone.uuid, record: record.uuid },
            body,
          })
        : send('POST', '/api/v1/admin/dns/zones/{id}/records', { path: { id: zone.uuid }, body });
    },
    { onSuccess: onClose },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={record ? t('dns.editTitle') : t('dns.addTitle', { name: zone.name })}
      description={t('dns.formHint', { name: zone.name })}
      submitLabel={record ? t('dns.save') : t('dns.add')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <FormField
          control={control}
          name="type"
          label={t('dns.type')}
          render={(f) => (
            <Select
              id={f.id}
              value={String(f.value)}
              onValueChange={(v) => {
                f.onChange(v);
                if (!PROXIABLE.includes(v as DnsRecordForm['type'])) setValue('proxied', false);
              }}
              aria-invalid={f['aria-invalid']}
              options={DNS_TYPES.map((x) => ({ value: x, label: x }))}
            />
          )}
        />
        <TextField
          control={control}
          name="name"
          label={t('dns.name')}
          placeholder="@, www, mail"
          description={t('dns.nameHint', { name: zone.name })}
          autoComplete="off"
        />
      </div>
      <TextField
        control={control}
        name="content"
        label={t('dns.content')}
        placeholder={DNS_PLACEHOLDER[type]}
        description={t(`dns.contentHint.${type}`)}
        autoComplete="off"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={control}
          name="ttl"
          label="TTL"
          render={(f) => (
            <Select
              id={f.id}
              value={String(f.value)}
              onValueChange={(v) => f.onChange(Number(v))}
              aria-invalid={f['aria-invalid']}
              options={[...new Set([...TTLS, record?.ttl ?? 300])]
                .sort((a, b) => a - b)
                .map((x) => ({ value: String(x), label: t('dns.ttlValue', { count: x }) }))}
            />
          )}
        />
        {NEEDS_PRIORITY.includes(type) && (
          <TextField control={control} name="priority" type="number" label={t('dns.priority')} />
        )}
      </div>
      {cf && PROXIABLE.includes(type) && (
        <FormField
          control={control}
          name="proxied"
          label={t('dns.proxyLabel')}
          description={t('dns.proxyHint')}
          render={(f) => (
            <Switch
              id={f.id}
              checked={f.value as boolean}
              onCheckedChange={f.onChange}
              aria-describedby={f['aria-describedby']}
            />
          )}
        />
      )}
    </FormDialog>
  );
}
