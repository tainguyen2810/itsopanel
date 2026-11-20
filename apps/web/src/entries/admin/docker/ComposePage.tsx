import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { useSession } from '@/shared/session/SessionContext';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { FormField } from '@/ui/FormField';
import { list, send, type JobAccepted, type Row } from '../api';
import { useAction } from '../useAction';

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
  compose_yaml: z
    .string()
    .max(262144, 'form.invalid')
    .refine((v) => /^services:\s*$/m.test(v), 'admin:compose.errors.services'),
});
type Form = z.infer<typeof composeSchema>;

export default function ComposePage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { user } = useSession();
  const [creating, setCreating] = useState(false);
  const columns: ColumnDef<Project, unknown>[] = [
    {
      id: 'name',
      header: t('compose.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <AppLink
          href={`/admin/compose-projects/${row.original.uuid}`}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </AppLink>
      ),
    },
    { id: 'server', header: t('jobs.server'), accessorFn: (p) => p.server.name },
    {
      id: 'status',
      header: t('servers.status'),
      accessorKey: 'status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    { id: 'services', header: t('compose.services'), accessorKey: 'services' },
    { id: 'revision', header: t('compose.revision'), accessorKey: 'revision' },
    {
      id: 'validation',
      header: t('compose.validation'),
      accessorFn: (p) => (p.validation.ok ? p.validation.warnings.length : -1),
      cell: ({ row }) =>
        row.original.validation.ok ? (
          row.original.validation.warnings.length > 0 ? (
            <Badge tone="warning">
              {t('compose.warnings', { count: row.original.validation.warnings.length })}
            </Badge>
          ) : (
            <StatusBadge status="pass" />
          )
        ) : (
          <StatusBadge status="fail" />
        ),
    },
    { id: 'updated', header: t('compose.updated'), accessorFn: (p) => fmt.rel(p.updated_at) },
  ];
  return (
    <>
      <ListPage<Project>
        title={t('compose.title')}
        description={t('compose.description')}
        actions={
          user.role === 'SUPER_ADMIN' ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('compose.create')}
            </Button>
          ) : undefined
        }
        queryKey={['admin', 'compose']}
        fetch={(q) => list('/api/v1/admin/compose-projects', q)}
        columns={columns}
        getRowId={(p) => p.uuid}
        primaryColumnId="name"
      />
      {user.role === 'SUPER_ADMIN' && <CreateCompose open={creating} onOpenChange={setCreating} />}
    </>
  );
}

function CreateCompose({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const servers = useQuery({
    queryKey: ['admin', 'servers', 'docker'],
    queryFn: () => list('/api/v1/admin/servers'),
    enabled: open,
  });
  const { control, handleSubmit } = useForm<Form>({
    resolver: zodResolver(composeSchema),
    defaultValues: { server_uuid: '', name: '', compose_yaml: COMPOSE_TEMPLATE },
  });
  const create = useAction(
    (v: Form) => send<JobAccepted>('POST', '/api/v1/admin/compose-projects', { body: v }),
    {
      onSuccess: (r) => {
        onOpenChange(false);
        if (r.resource)
          void navigate({ to: '/compose-projects/$id', params: { id: r.resource.uuid } });
      },
    },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('compose.createTitle')}
      description={t('compose.createHint')}
      submitLabel={t('compose.deploy')}
      pending={create.isPending}
      onSubmit={() => void handleSubmit((v) => create.mutate(v))()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="server_uuid"
          label={t('jobs.server')}
          placeholder={t('compose.pickServer')}
          options={(servers.data ?? []).map((s) => ({ value: s.uuid, label: s.name }))}
        />
        <TextField control={control} name="name" label={t('compose.name')} placeholder="web-demo" />
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
            rows={10}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-surface px-3 py-2 font-mono text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-invalid:border-danger"
          />
        )}
      />
    </FormDialog>
  );
}
