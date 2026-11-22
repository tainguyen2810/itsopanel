import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { certDays, UptimeResults } from '@/shared/monitoring/UptimeResults';
import { SelectField, SwitchField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { type ColumnDef } from '@/ui/DataTable';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { RowMenu } from '@/shared/hosting/pages/common';
import { get, list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { MonitoringNav } from './MonitoringPage';

type Check = Row<'/api/v1/admin/uptime-checks'>;

/** Đường dẫn trong website (D-105): không nhập URL tùy ý. */
export const uptimeSchema = z.object({
  website_uuid: z.string().min(1, 'form.required'),
  path: z
    .string()
    .trim()
    .max(200, 'form.maxLength|200')
    .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/, 'admin:uptime.errors.path'),
  interval_sec: z
    .number({ error: 'admin:packages.errors.number' })
    .int('admin:packages.errors.number')
    .min(60, 'admin:packages.errors.min|60')
    .max(3600, 'admin:packages.errors.max|3600'),
  keyword: z.string().trim().max(100, 'form.maxLength|100'),
  enabled: z.boolean(),
});
type Form = z.infer<typeof uptimeSchema>;

export default function UptimePage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [editing, setEditing] = useState<Check | 'new' | null>(null);
  const [viewing, setViewing] = useState<Check | null>(null);
  const [deleting, setDeleting] = useState<Check | null>(null);
  const inv = { invalidate: [['admin', 'uptime']] as unknown[][] };
  const toggle = useAction(
    (c: Check) =>
      send('PATCH', '/api/v1/admin/uptime-checks/{id}', {
        path: { id: c.uuid },
        body: { enabled: c.enabled === false },
      }),
    inv,
  );
  const remove = useAction(
    (c: Check) => send('DELETE', '/api/v1/admin/uptime-checks/{id}', { path: { id: c.uuid } }),
    { ...inv, success: t('uptime.deleted'), onSuccess: () => setDeleting(null) },
  );
  const columns: ColumnDef<Check, unknown>[] = [
    {
      id: 'site',
      header: t('sites.domain'),
      accessorFn: (c) => c.website.primary_domain,
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/websites/${row.original.website.uuid}`}
            className="font-medium break-all hover:underline"
          >
            {row.original.website.primary_domain}
          </AppLink>
          <p className="text-sm break-all text-muted">{row.original.path ?? '/'}</p>
        </div>
      ),
    },
    {
      id: 'state',
      header: t('sites.status'),
      accessorFn: (c) => c.state ?? '',
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge status={row.original.state ?? 'unknown'} />
          {row.original.state === 'down' && (
            <span className="text-xs text-danger-text">
              {row.original.last_error ?? row.original.last_status}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'uptime',
      header: t('uptime.ratio'),
      accessorKey: 'uptime_30d',
      cell: ({ row }) => (
        <span className="flex flex-col text-sm tabular-nums">
          <span>
            {t('uptime.window.0')} {fmt.pct(row.original.uptime_24h ?? 100, 2)}
          </span>
          <span className={row.original.uptime_30d < 99.5 ? 'text-danger-text' : 'text-muted'}>
            {t('uptime.window.2')} {fmt.pct(row.original.uptime_30d, 2)}
          </span>
        </span>
      ),
    },
    {
      id: 'latency',
      header: t('mon.latency'),
      accessorFn: (c) => c.last_latency_ms ?? -1,
      cell: ({ row }) =>
        row.original.last_latency_ms === null ? '—' : `${fmt.num(row.original.last_latency_ms)} ms`,
    },
    {
      id: 'cert',
      header: t('uptime.cert'),
      accessorFn: (c) => c.cert_expires_at ?? '',
      cell: ({ row }) => {
        const d = certDays(row.original.cert_expires_at);
        return d === null ? (
          '—'
        ) : (
          <Badge tone={d <= 7 ? 'danger' : d <= 14 ? 'warning' : 'neutral'}>
            {t('uptime.daysLeft', { count: d })}
          </Badge>
        );
      },
    },
    {
      id: 'checked',
      header: t('mon.checked'),
      accessorFn: (c) => c.last_checked_at ?? '',
      cell: ({ row }) =>
        row.original.last_checked_at ? fmt.rel(row.original.last_checked_at) : '—',
    },
    {
      id: 'enabled',
      header: t('alerts.enabled'),
      accessorFn: (c) => (c.enabled === false ? 0 : 1),
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled !== false}
          disabled={toggle.isPending}
          onCheckedChange={() => toggle.mutate(row.original)}
          aria-label={t('uptime.toggle', { name: row.original.website.primary_domain })}
        />
      ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('uptime.actionsFor', { name: row.original.website.primary_domain })}
          actions={[
            { label: t('uptime.results'), onSelect: () => setViewing(row.original) },
            { label: t('alerts.edit'), onSelect: () => setEditing(row.original) },
            { label: t('alerts.delete'), onSelect: () => setDeleting(row.original), danger: true },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Check>
        title={t('uptime.title')}
        description={t('uptime.description')}
        nav={<MonitoringNav current="uptime" />}
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('uptime.add')}
          </Button>
        }
        queryKey={['admin', 'uptime']}
        fetch={(q) => list('/api/v1/admin/uptime-checks', q)}
        columns={columns}
        getRowId={(c) => c.uuid}
        primaryColumnId="site"
      />
      {editing && (
        <UptimeDialog check={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      <Dialog open={viewing !== null} onOpenChange={(o) => !o && setViewing(null)}>
        {viewing && <ResultsDialog check={viewing} />}
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('uptime.deleteTitle', { name: deleting?.website.primary_domain ?? '' })}
        description={t('uptime.deleteHint')}
        confirmLabel={t('alerts.delete')}
        onConfirm={() =>
          deleting ? remove.mutateAsync(deleting).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function ResultsDialog({ check }: { check: Check }) {
  const { t } = useTranslation('admin');
  const results = useQuery({
    queryKey: ['admin', 'uptime', check.uuid, 'results'],
    queryFn: () => get('/api/v1/admin/uptime-checks/{id}/results', { path: { id: check.uuid } }),
  });
  return (
    <DialogContent
      title={t('uptime.resultsTitle', { name: check.website.primary_domain })}
      className="max-w-2xl"
    >
      <UptimeResults check={check} results={results.data ?? []} />
    </DialogContent>
  );
}

function UptimeDialog({ check, onClose }: { check: Check | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const websites = useQuery({
    queryKey: ['admin', 'websites', 'all'],
    queryFn: () => list('/api/v1/admin/websites'),
    enabled: check === null,
  });
  const checks = useQuery({
    queryKey: ['admin', 'uptime'],
    queryFn: () => list('/api/v1/admin/uptime-checks'),
    enabled: check === null,
  });
  const taken = new Set((checks.data ?? []).map((c) => c.website.uuid));
  const { control, handleSubmit } = useForm<Form>({
    resolver: zodResolver(uptimeSchema),
    defaultValues: {
      website_uuid: check?.website.uuid ?? '',
      path: check?.path ?? '/',
      interval_sec: check?.interval_sec ?? 60,
      keyword: check?.keyword ?? '',
      enabled: check?.enabled ?? true,
    },
  });
  const save = useAction(
    (v: Form) => {
      const body = {
        path: v.path,
        interval_sec: v.interval_sec,
        keyword: v.keyword === '' ? null : v.keyword,
        enabled: v.enabled,
      };
      return check
        ? send('PATCH', '/api/v1/admin/uptime-checks/{id}', { path: { id: check.uuid }, body })
        : send('POST', '/api/v1/admin/uptime-checks', {
            body: { ...body, website_uuid: v.website_uuid },
          });
    },
    { success: t('uptime.saved'), invalidate: [['admin', 'uptime']], onSuccess: onClose },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        check ? t('uptime.editTitle', { name: check.website.primary_domain }) : t('uptime.add')
      }
      description={t('uptime.formHint')}
      submitLabel={t('alerts.save')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      {check === null && (
        <SelectField
          control={control}
          name="website_uuid"
          label={t('uptime.website')}
          placeholder={t('uptime.pickWebsite')}
          options={(websites.data ?? [])
            .filter((w) => !taken.has(w.uuid))
            .map((w) => ({ value: w.uuid, label: w.primary_domain }))}
        />
      )}
      <TextField
        control={control}
        name="path"
        label={t('uptime.path')}
        description={t('uptime.pathHint')}
      />
      <div className="grid grid-cols-2 gap-4">
        <TextField
          control={control}
          name="interval_sec"
          type="number"
          inputMode="numeric"
          label={t('uptime.intervalSec')}
        />
        <TextField
          control={control}
          name="keyword"
          label={t('uptime.keyword')}
          description={t('uptime.keywordHint')}
          optional
        />
      </div>
      <SwitchField control={control} name="enabled" label={t('alerts.enabled')} />
    </FormDialog>
  );
}
