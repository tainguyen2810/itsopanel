import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowDownToLine, CheckCheck, Play, Square, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { DetailPage } from '@/shared/page/DetailPage';
import { InfoList } from '@/shared/page/InfoList';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { useCrumbName } from '@/shared/routing/crumbs';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { get, list, send, type Data } from '../api';
import { useAction } from '../useAction';

type Project = Data<'/api/v1/admin/compose-projects/{id}'>;

export default function ComposeDetailPage() {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const navigate = useNavigate();
  const { id } = useParams({ strict: false }) as { id: string };
  const q = useQuery({
    queryKey: ['admin', 'compose', id],
    queryFn: () => get('/api/v1/admin/compose-projects/{id}', { path: { id } }),
  });
  useCrumbName(id, q.data?.name);
  const [deleting, setDeleting] = useState(false);
  const act = useAction((a: 'up' | 'down' | 'pull' | 'validate') =>
    send('POST', `/api/v1/admin/compose-projects/{id}:${a}`, { path: { id } }),
  );
  const del = useAction(
    () => send('DELETE', '/api/v1/admin/compose-projects/{id}', { path: { id } }),
    {
      onSuccess: () => void navigate({ to: '/compose-projects' }),
    },
  );

  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <>
        <PageHeader title={t('compose.detail')} />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const p = q.data;
  const sa = user.role === 'SUPER_ADMIN';
  return (
    <>
      <DetailPage
        title={p.name}
        meta={<StatusBadge status={p.status} />}
        description={t('compose.on', { server: p.server.name })}
        actions={
          <>
            {p.status === 'running' ? (
              <Button variant="outline" onClick={() => act.mutate('down')}>
                <Square aria-hidden />
                {t('compose.down')}
              </Button>
            ) : (
              <Button onClick={() => act.mutate('up')}>
                <Play aria-hidden />
                {t('compose.up')}
              </Button>
            )}
            <Button variant="outline" onClick={() => act.mutate('pull')}>
              <ArrowDownToLine aria-hidden />
              {t('compose.pull')}
            </Button>
            <Button variant="outline" onClick={() => act.mutate('validate')}>
              <CheckCheck aria-hidden />
              {t('compose.validate')}
            </Button>
            {sa && (
              <Button variant="outline" onClick={() => setDeleting(true)}>
                <Trash2 aria-hidden />
                {t('compose.delete')}
              </Button>
            )}
          </>
        }
        tabs={[
          { value: 'overview', label: t('servers.tabs.overview'), content: <Overview p={p} /> },
          { value: 'yaml', label: 'compose.yaml', content: <Yaml p={p} editable={sa} /> },
          { value: 'containers', label: t('docker.containers'), content: <Containers p={p} /> },
        ]}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('compose.deleteTitle', { name: p.name })}
        description={t('compose.deleteHint')}
        confirmName={p.name}
        confirmLabel={t('compose.delete')}
        onConfirm={() => del.mutateAsync().then(() => setDeleting(false))}
      />
    </>
  );
}

function Overview({ p }: { p: Project }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title={t('servers.info')} />
        <CardContent>
          <InfoList
            items={[
              [
                t('jobs.server'),
                <AppLink
                  key="s"
                  href={`/admin/servers/${p.server.uuid}/docker`}
                  className="text-primary-text hover:underline"
                >
                  {p.server.name}
                </AppLink>,
              ],
              [t('compose.services'), String(p.services)],
              [t('compose.revision'), String(p.revision)],
              [t('servers.createdAt'), fmt.dateTime(p.created_at)],
              [t('compose.updated'), fmt.dateTime(p.updated_at)],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader title={t('compose.validation')} />
        <CardContent className="flex flex-col gap-2">
          {p.validation.ok ? (
            p.validation.warnings.length === 0 ? (
              <Alert tone="success" title={t('compose.valid')} />
            ) : (
              p.validation.warnings.map((w) => <Alert key={w} tone="warning" title={w} />)
            )
          ) : (
            <Alert tone="danger" title={t('compose.invalid')} />
          )}
          <p className="text-sm text-muted">{t('compose.policy')}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Yaml({ p, editable }: { p: Project; editable: boolean }) {
  const { t } = useTranslation('admin');
  const [text, setText] = useState(p.compose_yaml);
  const save = useAction(() =>
    send('PATCH', '/api/v1/admin/compose-projects/{id}', {
      path: { id: p.uuid },
      body: { compose_yaml: text },
    }),
  );
  const ok = /^services:\s*$/m.test(text);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <label htmlFor="compose-yaml" className="text-base font-medium">
          compose.yaml
        </label>
        <textarea
          id="compose-yaml"
          value={text}
          readOnly={!editable}
          onChange={(e) => setText(e.target.value)}
          rows={16}
          spellCheck={false}
          aria-invalid={!ok}
          aria-describedby="compose-yaml-hint"
          className="w-full rounded-md border border-input bg-surface px-3 py-2 font-mono text-sm text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring aria-invalid:border-danger"
        />
        <p
          id="compose-yaml-hint"
          className={ok ? 'text-sm text-muted' : 'text-sm text-danger-text'}
        >
          {ok ? t('compose.yamlHint') : t('compose.errors.services')}
        </p>
        {editable && (
          <div className="flex justify-end">
            <Button
              onClick={() => save.mutate()}
              disabled={!ok || text === p.compose_yaml || save.isPending}
            >
              {t('compose.saveDeploy')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Containers({ p }: { p: Project }) {
  const { t } = useTranslation('admin');
  const q = useQuery({
    queryKey: ['admin', 'server', p.server.uuid, 'containers'],
    queryFn: () =>
      list('/api/v1/admin/servers/{id}/docker/containers', undefined, {
        path: { id: p.server.uuid },
      }),
  });
  const mine = (q.data ?? []).filter((c) => c.compose_project === p.name);
  return (
    <Card>
      <CardContent>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : mine.length === 0 ? (
          <p className="text-base text-muted">{t('compose.noContainers')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {mine.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <p className="font-medium">{c.name}</p>
                  <p className="font-mono text-sm text-muted">{c.image}</p>
                </div>
                <StatusBadge status={c.state} />
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm">
          <AppLink
            href={`/admin/servers/${p.server.uuid}/docker`}
            className="text-primary-text hover:underline"
          >
            {t('compose.manageContainers')}
          </AppLink>
        </p>
      </CardContent>
    </Card>
  );
}
