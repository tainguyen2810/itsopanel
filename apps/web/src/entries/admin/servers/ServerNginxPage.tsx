import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { useFmt } from '@/shared/format/useFmt';
import { TextField } from '@/shared/page/fields';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { FormField } from '@/ui/FormField';
import { get, send } from '../api';
import { useAction } from '../useAction';
import { ServerNav, useServer } from './common';

export const nginxSchema = z.object({
  worker_processes: z.string().regex(/^(auto|[0-9]{1,3})$/, 'admin:nginx.errors.workers'),
  worker_connections: z
    .number('form.invalid')
    .int()
    .min(256, 'admin:nginx.errors.connections')
    .max(65535, 'admin:nginx.errors.connections'),
  client_max_body_size: z.string().regex(/^[0-9]{1,5}[kmg]?$/, 'admin:nginx.errors.size'),
  gzip: z.boolean(),
  http2: z.boolean(),
  server_tokens: z.boolean(),
});
type Form = z.infer<typeof nginxSchema>;

export default function ServerNginxPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { user } = useSession();
  const server = useServer();
  const q = useQuery({
    queryKey: ['admin', 'server', server.id, 'nginx'],
    queryFn: () => get('/api/v1/admin/servers/{id}/nginx', { path: { id: server.id } }),
  });
  const { control, handleSubmit, reset, formState } = useForm<Form>({
    resolver: zodResolver(nginxSchema),
  });
  useEffect(() => {
    if (q.data) reset(q.data);
  }, [q.data, reset]);
  const save = useAction(
    (v: Form) =>
      send('PATCH', '/api/v1/admin/servers/{id}/nginx', { path: { id: server.id }, body: v }),
    {},
  );
  const sa = user.role === 'SUPER_ADMIN';
  const toggles = ['gzip', 'http2', 'server_tokens'] as const;

  return (
    <>
      <PageHeader
        nav={<ServerNav current="nginx" />}
        title={t('nginx.title')}
        description={t('nginx.description')}
      />
      {q.isPending ? (
        <PageSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Card className="max-w-3xl">
          <CardHeader
            title={t('nginx.global')}
            description={t('nginx.updated', { time: fmt.dateTime(q.data.updated_at) })}
          />
          <CardContent>
            <form
              noValidate
              className="flex flex-col gap-4"
              onSubmit={handleSubmit((v) => save.mutate(v))}
            >
              <fieldset disabled={!sa} className="grid gap-4 sm:grid-cols-3">
                <TextField
                  control={control}
                  name="worker_processes"
                  label="worker_processes"
                  description={t('nginx.workersHint')}
                />
                <TextField
                  control={control}
                  name="worker_connections"
                  type="number"
                  label="worker_connections"
                />
                <TextField
                  control={control}
                  name="client_max_body_size"
                  label="client_max_body_size"
                  description={t('nginx.sizeHint')}
                />
              </fieldset>
              <fieldset
                disabled={!sa}
                className="flex flex-col divide-y divide-border rounded-md border border-border"
              >
                {toggles.map((k) => (
                  <FormField
                    key={k}
                    control={control}
                    name={k}
                    label={t(`nginx.${k}`)}
                    description={t(`nginx.${k}Hint`)}
                    className="px-4 py-3"
                    render={(f) => (
                      <Switch
                        id={f.id}
                        checked={f.value === true}
                        onCheckedChange={f.onChange}
                        aria-describedby={f['aria-describedby']}
                      />
                    )}
                  />
                ))}
              </fieldset>
              {sa ? (
                <div className="flex flex-wrap items-center justify-end gap-3">
                  <p className="text-sm text-muted">{t('nginx.applyHint')}</p>
                  <Button type="submit" disabled={!formState.isDirty || save.isPending}>
                    {t('nginx.apply')}
                  </Button>
                </div>
              ) : (
                <Alert tone="info" title={t('servers.readOnly')} />
              )}
            </form>
          </CardContent>
        </Card>
      )}
    </>
  );
}
