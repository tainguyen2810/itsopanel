import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { BellOff, Plus } from 'lucide-react';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { useSession } from '@/shared/session/SessionContext';
import { CheckGroupField, SelectField, SwitchField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { Alert as Callout } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { Badge, SeverityBadge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/Tabs';
import { list, send, type Row } from '../api';
import { resourceHref } from '../labels';
import { useAction } from '../useAction';
import { RowMenu } from '@/shared/hosting/pages/common';
import { MonitoringNav } from './MonitoringPage';

type Rule = Row<'/api/v1/admin/alert-rules'>;
type Alert = Row<'/api/v1/admin/alerts'>;
type Preview = { matches: number; resources: { label: string; value: number | null }[] };

/** Chỉ số theo phạm vi (D-102); khớp danh sách nguồn của bộ máy đánh giá. */
export const RULE_METRICS = {
  server: [
    'cpu_pct',
    'ram_pct',
    'swap_pct',
    'disk_pct',
    'inode_pct',
    'load_1m',
    'agent_offline_sec',
    'service_down',
  ],
  hosting_account: ['quota_disk_pct', 'cpu_pct', 'ram_pct', 'backup_failed'],
  website: ['http_latency_ms', 'http_status', 'uptime_down', 'cert_days'],
} as const;
const OPS = ['gt', 'gte', 'lt', 'lte'] as const;
const SEV = ['low', 'medium', 'high', 'critical'] as const;
export const CHANNELS = ['in_app', 'email', 'telegram', 'webhook'] as const;
/** Tắt tạm thông báo của một cảnh báo (giây). */
const SILENCE = [3600, 14400, 86400] as const;

export const ruleSchema = z
  .object({
    name: z.string().trim().min(1, 'form.required').max(120, 'form.maxLength|120'),
    scope_type: z.enum(['server', 'hosting_account', 'website']),
    metric: z.string().min(1, 'form.required'),
    operator: z.enum(OPS),
    threshold: z.number({ error: 'admin:packages.errors.number' }),
    for_sec: z
      .number({ error: 'admin:packages.errors.number' })
      .int('admin:packages.errors.number')
      .min(0, 'admin:packages.errors.min|0')
      .max(86400, 'admin:packages.errors.max|86400'),
    repeat_sec: z
      .number({ error: 'admin:packages.errors.number' })
      .int('admin:packages.errors.number')
      .min(0, 'admin:packages.errors.min|0')
      .max(604800, 'admin:packages.errors.max|604800'),
    severity: z.enum(SEV),
    channels: z.array(z.enum(CHANNELS)).min(1, 'admin:alerts.errors.channels'),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (!(RULE_METRICS[v.scope_type] as readonly string[]).includes(v.metric))
      ctx.addIssue({ code: 'custom', path: ['metric'], message: 'form.required' });
    if (v.metric.endsWith('_pct') && (v.threshold < 0 || v.threshold > 100))
      ctx.addIssue({ code: 'custom', path: ['threshold'], message: 'admin:alerts.errors.pct' });
  });
type RuleForm = z.infer<typeof ruleSchema>;

export const unitOf = (metric: string) =>
  metric.endsWith('_pct')
    ? '%'
    : metric.endsWith('_ms')
      ? ' ms'
      : metric.endsWith('_sec')
        ? ' s'
        : metric === 'cert_days'
          ? ' d'
          : '';

export default function AlertsPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { user } = useSession();
  const sa = user.role === 'SUPER_ADMIN';
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const alerts = useQuery({
    queryKey: ['admin', 'alerts'],
    queryFn: () => list('/api/v1/admin/alerts'),
  });
  const all = alerts.data ?? [];
  const open = all.filter((a) => a.state !== 'resolved');
  const history = all.filter((a) => a.state === 'resolved');
  const inv = { invalidate: [['admin', 'alerts']] as unknown[][] };
  const ack = useAction(
    (a: Alert) => send('POST', '/api/v1/admin/alerts/{id}:ack', { path: { id: a.uuid } }),
    { ...inv, success: t('alerts.acked') },
  );
  const silence = useAction(
    ({ a, sec }: { a: Alert; sec: number }) =>
      send('POST', '/api/v1/admin/alerts/{id}:silence', {
        path: { id: a.uuid },
        body: { duration_sec: sec },
      }),
    { ...inv, success: t('alerts.silenced') },
  );
  const unsilence = useAction(
    (a: Alert) => send('POST', '/api/v1/admin/alerts/{id}:unsilence', { path: { id: a.uuid } }),
    { ...inv, success: t('alerts.unsilenced') },
  );
  const toggle = useAction(
    (r: Rule) =>
      send('PATCH', '/api/v1/admin/alert-rules/{id}', {
        path: { id: r.uuid },
        body: { enabled: !r.enabled },
      }),
    { invalidate: [['admin', 'alert-rules']] },
  );
  const remove = useAction(
    (r: Rule) => send('DELETE', '/api/v1/admin/alert-rules/{id}', { path: { id: r.uuid } }),
    {
      success: t('alerts.deleted'),
      invalidate: [['admin', 'alert-rules']],
      onSuccess: () => setDeleting(null),
    },
  );
  const describe = (r: Rule) =>
    t('alerts.condition', {
      metric: t(`alerts.metric.${r.metric}` as never, { defaultValue: r.metric }),
      op: t(`alerts.op.${r.operator}`),
      value: `${fmt.num(r.threshold)}${unitOf(r.metric)}`,
    });
  const alertColumns = (withActions: boolean): ColumnDef<Alert, unknown>[] => [
    {
      id: 'rule',
      header: t('alerts.rule'),
      accessorFn: (a) => a.rule.name,
      cell: ({ row }) => {
        const a = row.original;
        const href = resourceHref(a.resource);
        return (
          <div className="min-w-0">
            <p className="font-medium">{a.rule.name}</p>
            {href ? (
              <AppLink href={href} className="text-sm text-muted hover:underline">
                {a.message ?? a.resource.type}
              </AppLink>
            ) : (
              <span className="text-sm text-muted">{a.message ?? a.resource.type}</span>
            )}
          </div>
        );
      },
    },
    {
      id: 'sev',
      header: t('sec.severity'),
      accessorKey: 'severity',
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    },
    {
      id: 'value',
      header: t('alerts.value'),
      accessorKey: 'value',
      cell: ({ row }) => <span className="tabular-nums">{fmt.num(row.original.value, 1)}</span>,
    },
    {
      id: 'time',
      header: t('alerts.started'),
      accessorKey: 'started_at',
      cell: ({ row }) => (
        <span className="flex flex-col">
          <span>{fmt.rel(row.original.started_at)}</span>
          {row.original.resolved_at && (
            <span className="text-sm text-muted">
              {t('alerts.resolvedAt', { at: fmt.rel(row.original.resolved_at) })}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'state',
      header: t('sites.status'),
      accessorKey: 'state',
      cell: ({ row }) => {
        const a = row.original;
        return (
          <span className="flex flex-wrap items-center gap-1">
            <StatusBadge status={a.state} />
            {a.acknowledged_at && (
              <Badge tone="info" title={a.acknowledged_by?.name ?? ''}>
                {t('alerts.ackedBy', { name: a.acknowledged_by?.name ?? '' })}
              </Badge>
            )}
            {a.silenced_until && (
              <Badge tone="neutral">
                <BellOff aria-hidden className="size-3" />
                {t('alerts.silencedUntil', { at: fmt.time(a.silenced_until) })}
              </Badge>
            )}
          </span>
        );
      },
    },
    ...(withActions
      ? [
          {
            id: 'actions',
            header: t('sites.actions'),
            enableSorting: false,
            cell: ({ row }) => {
              const a = row.original;
              return (
                <RowMenu
                  label={t('alerts.alertActionsFor', { name: a.rule.name })}
                  actions={[
                    {
                      label: t('alerts.ack'),
                      onSelect: () => ack.mutate(a),
                      hidden: a.state !== 'firing' || Boolean(a.acknowledged_at),
                    },
                    ...SILENCE.map((sec) => ({
                      label: t('alerts.silenceFor', { d: fmt.duration(sec) }),
                      onSelect: () => silence.mutate({ a, sec }),
                      hidden: Boolean(a.silenced_until),
                    })),
                    {
                      label: t('alerts.unsilence'),
                      onSelect: () => unsilence.mutate(a),
                      hidden: !a.silenced_until,
                    },
                  ]}
                />
              );
            },
          } satisfies ColumnDef<Alert, unknown>,
        ]
      : []),
  ];
  const columns: ColumnDef<Rule, unknown>[] = [
    {
      id: 'name',
      header: t('alerts.rule'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {row.original.name}
            {row.original.is_default && <Badge tone="primary">{t('alerts.default')}</Badge>}
            {(row.original.firing_count ?? 0) > 0 && (
              <Badge tone="danger">
                {t('alerts.firingCount', { count: row.original.firing_count })}
              </Badge>
            )}
          </p>
          <p className="text-sm text-muted">{describe(row.original)}</p>
        </div>
      ),
    },
    {
      id: 'scope',
      header: t('alerts.scope'),
      accessorKey: 'scope_type',
      cell: ({ row }) => t(`alerts.scopes.${row.original.scope_type}`),
    },
    {
      id: 'for',
      header: t('alerts.for'),
      accessorKey: 'for_sec',
      cell: ({ row }) =>
        row.original.for_sec ? fmt.duration(row.original.for_sec) : t('alerts.immediately'),
    },
    {
      id: 'sev',
      header: t('sec.severity'),
      accessorKey: 'severity',
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    },
    {
      id: 'channels',
      header: t('alerts.channels'),
      accessorFn: (r) => r.channels.join(','),
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          {row.original.channels.map((c) => (
            <Badge key={c} tone="neutral">
              {t(`alerts.channel.${c}`)}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      id: 'enabled',
      header: t('alerts.enabled'),
      accessorFn: (r) => (r.enabled ? 1 : 0),
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          disabled={!sa || toggle.isPending}
          onCheckedChange={() => toggle.mutate(row.original)}
          aria-label={t('alerts.toggle', { name: row.original.name })}
        />
      ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) =>
        sa ? (
          <RowMenu
            label={t('alerts.actionsFor', { name: row.original.name })}
            actions={[
              { label: t('alerts.edit'), onSelect: () => setEditing(row.original) },
              {
                label: t('alerts.delete'),
                onSelect: () => setDeleting(row.original),
                danger: true,
                hidden: row.original.is_default === true,
              },
            ]}
          />
        ) : null,
    },
  ];
  return (
    <>
      <ListPage<Rule>
        title={t('alerts.title')}
        description={t('alerts.description')}
        nav={<MonitoringNav current="alerts" />}
        actions={
          sa ? (
            <Button onClick={() => setEditing('new')}>
              <Plus aria-hidden />
              {t('alerts.add')}
            </Button>
          ) : undefined
        }
        queryKey={['admin', 'alert-rules']}
        fetch={(q) => list('/api/v1/admin/alert-rules', q)}
        columns={columns}
        getRowId={(r) => r.uuid}
        primaryColumnId="name"
      >
        <Card className="mb-4">
          <CardHeader title={t('alerts.recent')} description={t('alerts.recentHint')} />
          <CardContent>
            <Tabs defaultValue="open">
              <TabsList aria-label={t('alerts.recent')}>
                <TabsTrigger value="open">
                  {t('alerts.tabs.open', { count: open.length })}
                </TabsTrigger>
                <TabsTrigger value="history">
                  {t('alerts.tabs.history', { count: history.length })}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="open" className="pt-3">
                <DataTable
                  data={open}
                  columns={alertColumns(true)}
                  getRowId={(a) => a.uuid}
                  primaryColumnId="rule"
                  caption={t('alerts.tabs.open', { count: open.length })}
                  empty={t('alerts.none')}
                />
              </TabsContent>
              <TabsContent value="history" className="pt-3">
                <DataTable
                  data={history}
                  columns={alertColumns(false)}
                  getRowId={(a) => a.uuid}
                  primaryColumnId="rule"
                  caption={t('alerts.tabs.history', { count: history.length })}
                  empty={t('alerts.none')}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        <h2 className="mb-2 text-lg font-semibold">{t('alerts.rules')}</h2>
      </ListPage>
      {editing && (
        <RuleDialog rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('alerts.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('alerts.deleteHint')}
        confirmLabel={t('alerts.delete')}
        onConfirm={() =>
          deleting ? remove.mutateAsync(deleting).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function RuleDialog({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [preview, setPreview] = useState<Preview | null>(null);
  const { control, handleSubmit, setValue, getValues } = useForm<RuleForm>({
    resolver: zodResolver(ruleSchema),
    defaultValues: {
      name: rule?.name ?? '',
      scope_type: rule?.scope_type ?? 'server',
      metric: rule?.metric ?? 'cpu_pct',
      operator: rule?.operator ?? 'gt',
      threshold: rule?.threshold ?? 85,
      for_sec: rule?.for_sec ?? 300,
      repeat_sec: rule?.repeat_sec ?? 14400,
      severity: rule?.severity ?? 'medium',
      channels: rule?.channels ?? ['in_app'],
      enabled: rule?.enabled ?? true,
    },
  });
  const scope = useWatch({ control, name: 'scope_type' });
  const metric = useWatch({ control, name: 'metric' });
  useEffect(() => {
    // Đổi phạm vi: chọn lại chỉ số đầu tiên của phạm vi mới nếu chỉ số cũ không còn hợp lệ.
    const allowed = RULE_METRICS[scope] as readonly string[];
    if (!allowed.includes(metric)) setValue('metric', allowed[0] ?? '');
  }, [scope, metric, setValue]);
  const locked = rule?.is_default === true;
  const save = useAction(
    (v: RuleForm) =>
      rule
        ? send('PATCH', '/api/v1/admin/alert-rules/{id}', {
            path: { id: rule.uuid },
            // Rule mặc định: chỉ đổi ngưỡng, thời gian, mức, kênh, bật/tắt.
            body: locked
              ? {
                  threshold: v.threshold,
                  for_sec: v.for_sec,
                  repeat_sec: v.repeat_sec,
                  severity: v.severity,
                  channels: v.channels,
                  enabled: v.enabled,
                }
              : v,
            headers: { 'If-Match': `"${rule.updated_at}"` },
          })
        : send('POST', '/api/v1/admin/alert-rules', { body: v }),
    { success: t('alerts.saved'), invalidate: [['admin', 'alert-rules']], onSuccess: onClose },
  );
  const check = useAction(
    () =>
      send<Preview>('POST', '/api/v1/admin/alert-rules:preview', {
        // Trường bị khóa (luật mặc định) không có trong getValues(): lấy lại từ luật gốc.
        body: {
          ...getValues(),
          ...(rule?.is_default
            ? {
                name: rule.name,
                scope_type: rule.scope_type,
                metric: rule.metric,
                operator: rule.operator,
              }
            : {}),
        },
      }),
    { onSuccess: setPreview },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={rule ? t('alerts.editTitle', { name: rule.name }) : t('alerts.add')}
      description={locked ? t('alerts.defaultHint') : t('alerts.formHint')}
      submitLabel={t('alerts.save')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      <TextField control={control} name="name" label={t('alerts.name')} disabled={locked} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="scope_type"
          label={t('alerts.scope')}
          disabled={locked}
          options={(Object.keys(RULE_METRICS) as (keyof typeof RULE_METRICS)[]).map((s) => ({
            value: s,
            label: t(`alerts.scopes.${s}`),
          }))}
        />
        <SelectField
          control={control}
          name="metric"
          label={t('alerts.metricLabel')}
          disabled={locked}
          options={RULE_METRICS[scope].map((m) => ({ value: m, label: t(`alerts.metric.${m}`) }))}
          placeholder={t('alerts.pickMetric')}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <SelectField
          control={control}
          name="operator"
          label={t('alerts.operator')}
          disabled={locked}
          options={OPS.map((o) => ({ value: o, label: t(`alerts.op.${o}`) }))}
        />
        <TextField
          control={control}
          name="threshold"
          type="number"
          label={t('alerts.threshold')}
          {...(unitOf(metric)
            ? { description: t('alerts.unit', { unit: unitOf(metric).trim() }) }
            : {})}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <TextField
          control={control}
          name="for_sec"
          type="number"
          inputMode="numeric"
          label={t('alerts.forSec')}
          description={t('alerts.forHint')}
        />
        <TextField
          control={control}
          name="repeat_sec"
          type="number"
          inputMode="numeric"
          label={t('alerts.repeatSec')}
          description={t('alerts.repeatHint')}
        />
      </div>
      <SelectField
        control={control}
        name="severity"
        label={t('sec.severity')}
        options={SEV.map((s) => ({
          value: s,
          label: t(`common:severity.${s}` as never) as string,
        }))}
      />
      <CheckGroupField
        control={control}
        name="channels"
        label={t('alerts.channels')}
        options={CHANNELS.map((c) => ({ value: c, label: t(`alerts.channel.${c}`) }))}
      />
      <SwitchField control={control} name="enabled" label={t('alerts.enabled')} />
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="secondary"
          className="self-start"
          disabled={check.isPending}
          onClick={() => check.mutate(undefined)}
        >
          {t('alerts.preview')}
        </Button>
        {preview && (
          <Callout
            tone={preview.matches > 0 ? 'warning' : 'success'}
            title={t('alerts.previewResult', { count: preview.matches })}
          >
            {preview.resources
              .map((r) => (r.value === null ? r.label : `${r.label} (${fmt.num(r.value, 1)})`))
              .join(', ')}
          </Callout>
        )}
      </div>
    </FormDialog>
  );
}
