import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CheckCheck, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { FormField } from '@/ui/FormField';
import { Input } from '@/ui/Input';
import { list, send, type JobAccepted, type Row } from '../api';
import { useAction } from '../useAction';
import { blockingFindings, ValidationView, type Validation } from './validation';

type Project = Row<'/api/v1/admin/compose-projects'>;

export const COMPOSE_TEMPLATE = `services:
  web:
    image: nginx:1.27-alpine
    ports:
      - "127.0.0.1:8080:80"
    restart: unless-stopped
`;

export const composeSchema = z.object({
  server_uuid: z.string().min(1, 'form.required'),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/, 'admin:compose.errors.name'),
  template: z.string(),
  compose_yaml: z
    .string()
    .max(262144, 'form.invalid')
    .refine((v) => /^services:\s*$/m.test(v), 'admin:compose.errors.services'),
});
type Form = z.infer<typeof composeSchema>;

export default function ComposePage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [creating, setCreating] = useState(false);
  const columns: ColumnDef<Project, unknown>[] = [
    {
      id: 'name',
      header: t('compose.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/compose-projects/${row.original.uuid}`}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </AppLink>
          {row.original.template && (
            <p className="text-sm text-muted">
              {t('compose.fromTemplate', { name: row.original.template })}
            </p>
          )}
        </div>
      ),
    },
    { id: 'server', header: t('jobs.server'), accessorFn: (p) => p.server.name },
    {
      id: 'status',
      header: t('servers.status'),
      accessorKey: 'status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: 'ports',
      header: t('compose.ports'),
      accessorFn: (p) => p.ports.map((x) => x.host_port).join(', ') || '—',
      cell: ({ getValue }) => <span className="font-mono text-sm">{getValue<string>()}</span>,
    },
    {
      id: 'images',
      header: t('compose.images'),
      accessorFn: (p) => p.images.filter((i) => i.update_available).length,
      cell: ({ row }) => {
        const n = row.original.images.filter((i) => i.update_available).length;
        return n > 0 ? (
          <Badge tone="info">{t('compose.updates', { count: n })}</Badge>
        ) : (
          <span className="text-sm text-muted">{t('compose.imagesCurrent')}</span>
        );
      },
    },
    {
      id: 'validation',
      header: t('compose.validation'),
      accessorFn: (p) => p.validation.findings.length,
      cell: ({ row }) => {
        const v = row.original.validation;
        const blocking = blockingFindings(
          v,
          v.overrides.map((o) => o.rule),
        );
        if (blocking.length > 0) return <StatusBadge status="fail" />;
        if (v.overrides.length > 0)
          return (
            <Badge tone="info">{t('compose.overridesCount', { count: v.overrides.length })}</Badge>
          );
        const w = v.findings.filter((f) => f.severity === 'warning').length;
        return w > 0 ? (
          <Badge tone="warning">{t('compose.warnings', { count: w })}</Badge>
        ) : (
          <StatusBadge status="pass" />
        );
      },
    },
    { id: 'revision', header: t('compose.revision'), accessorKey: 'revision' },
    { id: 'updated', header: t('compose.updated'), accessorFn: (p) => fmt.rel(p.updated_at) },
  ];
  return (
    <>
      <ListPage<Project>
        title={t('compose.title')}
        description={t('compose.description')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('compose.create')}
          </Button>
        }
        queryKey={['admin', 'compose']}
        fetch={(q) => list('/api/v1/admin/compose-projects', q)}
        columns={columns}
        getRowId={(p) => p.uuid}
        primaryColumnId="name"
      />
      {creating && <CreateCompose onClose={() => setCreating(false)} />}
    </>
  );
}

type Override = { rule: string; reason: string };

/** Override từng rule (chỉ SA, D-96): chọn rule bị chặn có thể override + lý do ≥ 10 ký tự. */
export function OverridePicker({
  v,
  value,
  onChange,
}: {
  v: Validation;
  value: Override[];
  onChange: (o: Override[]) => void;
}) {
  const { t } = useTranslation('admin');
  const rules = [
    ...new Set(
      v.findings.filter((f) => f.severity === 'error' && f.overridable).map((f) => f.rule),
    ),
  ];
  if (rules.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-warning/40 p-3">
      <legend className="px-1 text-base font-medium">{t('compose.overrideTitle')}</legend>
      <p className="text-sm text-muted">{t('compose.overrideHint')}</p>
      {rules.map((rule) => {
        const cur = value.find((o) => o.rule === rule);
        return (
          <div key={rule} className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-base">
              <input
                type="checkbox"
                checked={cur !== undefined}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...value, { rule, reason: '' }]
                      : value.filter((o) => o.rule !== rule),
                  )
                }
              />
              <code>{rule}</code>
            </label>
            {cur && (
              <Input
                aria-label={t('compose.overrideReason', { rule })}
                placeholder={t('compose.overrideReasonPh')}
                value={cur.reason}
                onChange={(e) =>
                  onChange(
                    value.map((o) => (o.rule === rule ? { rule, reason: e.target.value } : o)),
                  )
                }
              />
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

function CreateCompose({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const navigate = useNavigate();
  const sa = user.role === 'SUPER_ADMIN';
  const servers = useQuery({
    queryKey: ['admin', 'servers', 'docker'],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const templates = useQuery({
    queryKey: ['admin', 'compose-templates'],
    queryFn: () => list('/api/v1/admin/compose-templates'),
  });
  const { control, handleSubmit, setValue } = useForm<Form>({
    resolver: zodResolver(composeSchema),
    defaultValues: { server_uuid: '', name: '', template: '', compose_yaml: COMPOSE_TEMPLATE },
  });
  const [result, setResult] = useState<{ yaml: string; v: Validation } | null>(null);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const yaml = useWatch({ control, name: 'compose_yaml' });
  const server = useWatch({ control, name: 'server_uuid' });
  const check = useAction(
    () =>
      send<Validation>('POST', '/api/v1/admin/compose-projects:validate', {
        body: { server_uuid: server, compose_yaml: yaml, overrides },
      }),
    { onSuccess: (r) => setResult({ yaml, v: r }) },
  );
  const stale = result !== null && result.yaml !== yaml;
  const validOverrides = overrides.filter((o) => o.reason.trim().length >= 10);
  const blocking = result
    ? blockingFindings(
        result.v,
        validOverrides.map((o) => o.rule),
      )
    : [];
  const canDeploy = result !== null && !stale && blocking.length === 0;
  const create = useAction(
    (v: Form) =>
      send<JobAccepted>('POST', '/api/v1/admin/compose-projects', {
        body: {
          server_uuid: v.server_uuid,
          name: v.name,
          compose_yaml: v.compose_yaml,
          env: {},
          template: v.template || null,
          overrides: validOverrides,
        },
      }),
    {
      onSuccess: (r) => {
        onClose();
        if (r.resource)
          void navigate({ to: '/compose-projects/$id', params: { id: r.resource.uuid } });
      },
    },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('compose.createTitle')}
      description={t('compose.createHint')}
      submitLabel={t('compose.deploy')}
      submitDisabled={!canDeploy}
      pending={create.isPending}
      onSubmit={() => void handleSubmit((v) => create.mutate(v))()}
      className="max-w-3xl"
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField
          control={control}
          name="server_uuid"
          label={t('jobs.server')}
          placeholder={t('compose.pickServer')}
          options={(servers.data ?? []).map((s) => ({ value: s.uuid, label: s.name }))}
        />
        <TextField control={control} name="name" label={t('compose.name')} placeholder="web-demo" />
        <SelectField
          control={control}
          name="template"
          label={t('compose.template')}
          placeholder={t('compose.noTemplate')}
          options={(templates.data ?? []).map((x) => ({ value: x.key, label: x.name }))}
          onValueChange={(key) => {
            const tpl = templates.data?.find((x) => x.key === key);
            if (tpl) setValue('compose_yaml', tpl.compose_yaml, { shouldValidate: true });
          }}
        />
      </div>
      <FormField
        control={control}
        name="compose_yaml"
        label="compose.yaml"
        description={t('compose.yamlHint')}
        render={(f) => (
          <textarea
            {...f}
            value={String(f.value ?? '')}
            onChange={(e) => f.onChange(e.target.value)}
            rows={12}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-surface px-3 py-2 font-mono text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-invalid:border-danger"
          />
        )}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!server || check.isPending}
          onClick={() => check.mutate()}
        >
          <CheckCheck aria-hidden />
          {t('compose.check')}
        </Button>
        <span className="text-sm text-muted">
          {!server
            ? t('compose.pickServerFirst')
            : stale
              ? t('compose.stale')
              : result === null
                ? t('compose.checkFirst')
                : null}
        </span>
      </div>
      {result && !stale && (
        <>
          <ValidationView v={result.v} />
          {sa ? (
            <OverridePicker v={result.v} value={overrides} onChange={setOverrides} />
          ) : (
            blocking.some((f) => f.overridable) && (
              <Alert tone="info" title={t('compose.adminNoOverride')} />
            )
          )}
        </>
      )}
    </FormDialog>
  );
}
