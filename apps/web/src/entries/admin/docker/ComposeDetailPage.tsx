import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowDownToLine, CheckCheck, Globe, Play, RotateCcw, Square, Trash2 } from 'lucide-react';
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
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Skeleton } from '@/ui/Feedback';
import { get, list, send, type Data } from '../api';
import { useAction } from '../useAction';
import { OverridePicker } from './ComposePage';
import { blockingFindings, lineDiff, ValidationView, type Validation } from './validation';

type Project = Data<'/api/v1/admin/compose-projects/{id}'>;
type Image = Project['images'][number];

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
  const act = useAction(
    (a: 'up' | 'down' | 'pull' | 'validate') =>
      send('POST', `/api/v1/admin/compose-projects/{id}:${a}`, { path: { id } }),
    { invalidate: [['admin', 'compose', id]] },
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
            {p.status === 'running' || p.status === 'partial' ? (
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
          {
            value: 'validation',
            label: t('compose.validation'),
            content: (
              <Card>
                <CardContent>
                  <ValidationView v={p.validation} />
                  <p className="mt-3 text-sm text-muted">{t('compose.policy')}</p>
                </CardContent>
              </Card>
            ),
          },
          { value: 'yaml', label: 'compose.yaml', content: <Yaml p={p} /> },
          {
            value: 'revisions',
            label: t('compose.revisions'),
            content: <Revisions p={p} />,
          },
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
  const [confirm, setConfirm] = useState<{ kind: 'update' | 'rollback'; image: Image } | null>(
    null,
  );
  const run = useAction(
    (v: { kind: 'update' | 'rollback'; service: string }) =>
      send(
        'POST',
        v.kind === 'update'
          ? '/api/v1/admin/compose-projects/{id}:update-images'
          : '/api/v1/admin/compose-projects/{id}:rollback-images',
        { path: { id: p.uuid }, body: { services: [v.service] } },
      ),
    { invalidate: [['admin', 'compose', p.uuid]], onSuccess: () => setConfirm(null) },
  );
  const lu = p.last_image_update;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {lu && lu.state === 'rolled_back' && (
        <Alert
          tone="warning"
          className="lg:col-span-2"
          title={t('compose.rolledBack', { service: lu.service })}
        >
          {lu.reason} · {fmt.dateTime(lu.at)}
        </Alert>
      )}
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
              [t('compose.template'), p.template ?? t('compose.noTemplate')],
              [t('compose.volumes'), p.volumes.join(', ') || '—'],
              [t('servers.createdAt'), fmt.dateTime(p.created_at)],
              [t('compose.updated'), fmt.dateTime(p.updated_at)],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader title={t('compose.ports')} description={t('compose.portsHint')} />
        <CardContent className="flex flex-col gap-3">
          {p.ports.length === 0 ? (
            <p className="text-base text-muted">{t('compose.noPorts')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {p.ports.map((x) => (
                <li
                  key={`${x.service}-${x.container_port}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span>
                    <span className="font-medium">{x.service}</span>{' '}
                    <span className="font-mono text-sm text-muted">
                      127.0.0.1:{x.host_port} → {x.container_port}/{x.protocol}
                    </span>
                  </span>
                  {p.websites.some((w) => w.service === x.service) ? (
                    <Badge tone="success">{t('compose.published')}</Badge>
                  ) : (
                    <Badge tone="neutral">{t('compose.localOnly')}</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium">{t('compose.websites')}</p>
            {p.websites.length === 0 ? (
              <p className="text-sm text-muted">{t('compose.noWebsites')}</p>
            ) : (
              p.websites.map((w) => (
                <AppLink
                  key={w.uuid}
                  href={`/admin/websites/${w.uuid}`}
                  className="flex items-center gap-1.5 text-primary-text hover:underline"
                >
                  <Globe aria-hidden className="size-4" />
                  {w.ssl ? 'https' : 'http'}://{w.domain} → {w.service}
                </AppLink>
              ))
            )}
            <AppLink
              href={`/admin/websites?new=docker&project=${p.uuid}`}
              className="text-sm text-primary-text hover:underline"
            >
              {t('compose.attachDomain')}
            </AppLink>
          </div>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader title={t('compose.images')} description={t('compose.imagesHint')} />
        <CardContent>
          <ul className="flex flex-col divide-y divide-border">
            {p.images.map((im) => (
              <li
                key={im.service}
                className="flex flex-wrap items-center justify-between gap-3 py-2"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {im.service}{' '}
                    <span className="font-mono text-sm break-all text-muted">{im.image}</span>
                  </p>
                  <p className="font-mono text-xs text-muted">
                    {im.digest.slice(0, 19)}
                    {im.update_available && im.latest_digest && (
                      <> → {im.latest_digest.slice(0, 19)}</>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {im.update_available ? (
                    <Badge tone="info">{t('docker.updateAvailable')}</Badge>
                  ) : (
                    <Badge tone="success">{t('compose.imageCurrent')}</Badge>
                  )}
                  {im.update_available && (
                    <Button size="sm" onClick={() => setConfirm({ kind: 'update', image: im })}>
                      {t('compose.updateImage')}
                    </Button>
                  )}
                  {im.rollback_available && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirm({ kind: 'rollback', image: im })}
                    >
                      <RotateCcw aria-hidden />
                      {t('compose.rollbackImage')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="primary"
        title={
          confirm ? t(`compose.confirm.${confirm.kind}`, { service: confirm.image.service }) : ''
        }
        description={confirm ? t(`compose.confirmHint.${confirm.kind}`) : ''}
        confirmLabel={
          confirm
            ? confirm.kind === 'update'
              ? t('compose.updateImage')
              : t('compose.rollbackImage')
            : ''
        }
        onConfirm={() =>
          confirm
            ? run
                .mutateAsync({ kind: confirm.kind, service: confirm.image.service })
                .then(() => undefined)
            : undefined
        }
      />
    </div>
  );
}

function Yaml({ p }: { p: Project }) {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const sa = user.role === 'SUPER_ADMIN';
  const [text, setText] = useState(p.compose_yaml);
  const [result, setResult] = useState<{ yaml: string; v: Validation } | null>(null);
  const [overrides, setOverrides] = useState(
    p.validation.overrides.map((o) => ({ rule: o.rule, reason: o.reason })),
  );
  const check = useAction(
    () =>
      send<Validation>('POST', '/api/v1/admin/compose-projects:validate', {
        body: { server_uuid: p.server.uuid, compose_yaml: text, overrides },
      }),
    { onSuccess: (r) => setResult({ yaml: text, v: r }) },
  );
  const valid = overrides.filter((o) => o.reason.trim().length >= 10);
  const save = useAction(
    () =>
      send('PATCH', '/api/v1/admin/compose-projects/{id}', {
        path: { id: p.uuid },
        body: { compose_yaml: text, overrides: valid },
      }),
    { invalidate: [['admin', 'compose', p.uuid]] },
  );
  const ok = /^services:\s*$/m.test(text);
  const fresh = result !== null && result.yaml === text;
  const blocking = fresh
    ? blockingFindings(
        result.v,
        valid.map((o) => o.rule),
      )
    : [];
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <label htmlFor="compose-yaml" className="text-base font-medium">
          compose.yaml
        </label>
        <textarea
          id="compose-yaml"
          value={text}
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
          {ok ? t('compose.yamlHintRevision') : t('compose.errors.services')}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => check.mutate()}
            disabled={!ok || text === p.compose_yaml || check.isPending}
          >
            <CheckCheck aria-hidden />
            {t('compose.check')}
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!fresh || blocking.length > 0 || save.isPending}
          >
            {t('compose.saveDeploy')}
          </Button>
        </div>
        {fresh && (
          <>
            <ValidationView v={result.v} />
            {sa && <OverridePicker v={result.v} value={overrides} onChange={setOverrides} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Revisions({ p }: { p: Project }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'compose', p.uuid, 'revisions'],
    queryFn: () =>
      list('/api/v1/admin/compose-projects/{id}/revisions', undefined, {
        path: { id: p.uuid },
      }),
  });
  const [picked, setPicked] = useState<number | null>(null);
  if (q.isPending) return <Skeleton className="h-48" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const revs = q.data;
  const current = revs.find((r) => r.current) ?? revs[0];
  const sel = revs.find((r) => r.number === picked) ?? revs.find((r) => !r.current);
  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Card>
        <CardContent>
          <ul className="flex flex-col gap-1">
            {revs.map((r) => (
              <li key={r.number}>
                <button
                  type="button"
                  onClick={() => setPicked(r.number)}
                  aria-pressed={sel?.number === r.number}
                  className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left hover:bg-surface-hover aria-pressed:bg-surface-2"
                >
                  <span className="flex flex-wrap items-center gap-1.5 font-medium">
                    {t('compose.revN', { n: r.number })}
                    {r.current && <Badge tone="primary">{t('compose.current')}</Badge>}
                    {!r.ok && <Badge tone="danger">{t('compose.rejected')}</Badge>}
                    {r.overrides > 0 && (
                      <Badge tone="info">
                        {t('compose.overridesCount', { count: r.overrides })}
                      </Badge>
                    )}
                  </span>
                  <span className="text-sm text-muted">
                    {r.created_by?.name ?? '—'} · {fmt.dateTime(r.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader
          title={
            sel && current
              ? t('compose.diffTitle', { from: sel.number, to: current.number })
              : t('compose.revisions')
          }
          description={t('compose.diffHint')}
        />
        <CardContent>
          {sel && current && sel.number !== current.number ? (
            <pre
              className="max-h-[28rem] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-sm"
              aria-label={t('compose.diffTitle', { from: sel.number, to: current.number })}
            >
              {lineDiff(sel.compose_yaml, current.compose_yaml).map((l, i) => (
                <div
                  key={i}
                  className={
                    l.kind === 'add'
                      ? 'bg-success-soft text-success-text'
                      : l.kind === 'del'
                        ? 'bg-danger-soft text-danger-text'
                        : ''
                  }
                >
                  {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
                  {l.text}
                </div>
              ))}
            </pre>
          ) : (
            <p className="text-base text-muted">{t('compose.onlyOneRevision')}</p>
          )}
        </CardContent>
      </Card>
    </div>
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
                <span className="flex flex-wrap gap-1">
                  <StatusBadge status={c.state} />
                  {c.health && <StatusBadge status={c.health} />}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm">
          <AppLink
            href={`/admin/servers/${p.server.uuid}/docker?tab=containers`}
            className="text-primary-text hover:underline"
          >
            {t('compose.manageContainers')}
          </AppLink>
        </p>
      </CardContent>
    </Card>
  );
}
