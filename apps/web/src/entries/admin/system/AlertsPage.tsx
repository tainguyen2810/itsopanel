import { useEffect, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { useSession } from '@/shared/session/SessionContext';
import { CheckGroupField, SelectField, SwitchField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { Badge, SeverityBadge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { list, send, type Row } from '../api';
import { resourceHref } from '../labels';
import { useAction } from '../useAction';
import { RowMenu } from '../sites/common';
import { MonitoringNav } from './MonitoringPage';

type Rule = Row<'/api/v1/admin/alert-rules'>;
type Alert = Row<'/api/v1/admin/alerts'>;

export const RULE_METRICS = {
  server: ['cpu_pct', 'ram_pct', 'disk_pct', 'load_1m'],
  hosting_account: ['quota_disk_pct', 'cpu_pct', 'ram_pct'],
  website: ['http_latency_ms', 'http_status'],
} as const;
const OPS = ['gt', 'gte', 'lt', 'lte'] as const;
const SEV = ['low', 'medium', 'high', 'critical'] as const;
const CHANNELS = ['email', 'telegram', 'in_app'] as const;

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

const unitOf = (metric: string) =>
  metric.endsWith('_pct') ? '%' : metric.endsWith('_ms') ? ' ms' : '';

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
  const alertColumns: ColumnDef<Alert, unknown>[] = [
    {
      id: 'rule',
      header: t('alerts.rule'),
      accessorFn: (a) => a.rule.name,
      cell: ({ row }) => {
        const href = resourceHref(row.original.resource);
        const label = t(`alerts.scopes.${row.original.resource.type}` as never, {
          defaultValue: row.original.resource.type,
        });
        return (
          <div className="min-w-0">
            <p className="font-medium">{row.original.rule.name}</p>
            {href ? (
              <AppLink href={href} className="text-sm text-muted hover:underline">
                {label}
              </AppLink>
            ) : (
              <span className="text-sm text-muted">{label}</span>
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
      cell: ({ row }) => <StatusBadge status={row.original.state} />,
    },
  ];
  const columns: ColumnDef<Rule, unknown>[] = [
    {
      id: 'name',
      header: t('alerts.rule'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{row.original.name}</p>
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
            <DataTable
              data={alerts.data ?? []}
              columns={alertColumns}
              getRowId={(a) => a.uuid}
              primaryColumnId="rule"
              caption={t('alerts.recent')}
              empty={t('alerts.none')}
            />
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
  const { control, handleSubmit, setValue } = useForm<RuleForm>({
    resolver: zodResolver(ruleSchema),
    defaultValues: {
      name: rule?.name ?? '',
      scope_type: rule?.scope_type ?? 'server',
      metric: rule?.metric ?? 'cpu_pct',
      operator: rule?.operator ?? 'gt',
      threshold: rule?.threshold ?? 85,
      for_sec: rule?.for_sec ?? 300,
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
  const save = useAction(
    (v: RuleForm) =>
      rule
        ? send('PATCH', '/api/v1/admin/alert-rules/{id}', {
            path: { id: rule.uuid },
            body: v,
            headers: { 'If-Match': `"${rule.updated_at}"` },
          })
        : send('POST', '/api/v1/admin/alert-rules', { body: v }),
    { success: t('alerts.saved'), invalidate: [['admin', 'alert-rules']], onSuccess: onClose },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={rule ? t('alerts.editTitle', { name: rule.name }) : t('alerts.add')}
      description={t('alerts.formHint')}
      submitLabel={t('alerts.save')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      <TextField control={control} name="name" label={t('alerts.name')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="scope_type"
          label={t('alerts.scope')}
          options={(Object.keys(RULE_METRICS) as (keyof typeof RULE_METRICS)[]).map((s) => ({
            value: s,
            label: t(`alerts.scopes.${s}`),
          }))}
        />
        <SelectField
          control={control}
          name="metric"
          label={t('alerts.metricLabel')}
          options={RULE_METRICS[scope].map((m) => ({ value: m, label: t(`alerts.metric.${m}`) }))}
          placeholder={t('alerts.pickMetric')}
        />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <SelectField
          control={control}
          name="operator"
          label={t('alerts.operator')}
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
        <SelectField
          control={control}
          name="severity"
          label={t('sec.severity')}
          options={SEV.map((s) => ({
            value: s,
            label: t(`common:severity.${s}` as never) as string,
          }))}
        />
      </div>
      <CheckGroupField
        control={control}
        name="channels"
        label={t('alerts.channels')}
        options={CHANNELS.map((c) => ({ value: c, label: t(`alerts.channel.${c}`) }))}
      />
      <SwitchField control={control} name="enabled" label={t('alerts.enabled')} />
    </FormDialog>
  );
}
