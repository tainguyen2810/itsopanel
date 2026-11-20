import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { GitBranch, Plus, Rocket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { useUrlState } from '@/shared/page/useUrlState';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { CodeBlock } from '@/ui/CodeBlock';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { EmptyState } from '@/ui/Feedback';
import { FormField } from '@/ui/FormField';
import { Textarea } from '@/ui/Input';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { RowMenu, SecretDialog, useWebsites } from '@/shared/hosting/pages/common';
import { gitRepoSchema, splitLines, type GitRepoForm } from '@/shared/hosting/pages/forms';

type Repo = Row<'/api/v1/admin/git-repositories'>;
type Deploy = Row<'/api/v1/admin/git-repositories/{id}/deployments'>;

export default function GitDeploymentsPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [url, setUrl] = useUrlState();
  const [connecting, setConnecting] = useState(false);
  const repos = useQuery({
    queryKey: ['admin', 'git-repositories'],
    queryFn: () => list('/api/v1/admin/git-repositories'),
  });
  const repo = repos.data?.find((r) => r.uuid === url.repo) ?? repos.data?.[0];
  return (
    <>
      <PageHeader
        title={t('git.title')}
        description={t('git.description')}
        actions={
          <Button onClick={() => setConnecting(true)}>
            <Plus aria-hidden />
            {t('git.connect')}
          </Button>
        }
      />
      {repos.isError ? (
        <ErrorState error={repos.error} onRetry={() => void repos.refetch()} />
      ) : repos.isPending ? (
        <TableSkeleton rows={3} />
      ) : repos.data.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState icon={GitBranch} title={t('git.empty')} description={t('git.emptyHint')} />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <nav aria-label={t('git.repos')}>
            <ul className="flex flex-col gap-2">
              {repos.data.map((r) => (
                <li key={r.uuid}>
                  <button
                    type="button"
                    onClick={() => setUrl({ repo: r.uuid })}
                    {...(r.uuid === repo?.uuid ? { 'aria-current': 'true' as const } : {})}
                    className="flex w-full flex-col gap-1 rounded-lg border border-border bg-surface p-3 text-left hover:bg-surface-hover aria-[current=true]:border-primary aria-[current=true]:ring-1 aria-[current=true]:ring-primary"
                  >
                    <span className="font-medium break-all">{r.website.primary_domain}</span>
                    <span className="font-mono text-xs break-all text-muted">{r.repo_url}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
                      <Badge tone="neutral">
                        <GitBranch aria-hidden className="size-3" />
                        {r.branch}
                      </Badge>
                      {r.current_deployment ? (
                        <span className="font-mono">{r.current_deployment.commit_sha}</span>
                      ) : (
                        t('git.never')
                      )}
                      {r.current_deployment?.finished_at && (
                        <span>· {fmt.rel(r.current_deployment.finished_at)}</span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {repo && <RepoDetail key={repo.uuid} repo={repo} />}
        </div>
      )}
      {connecting && <RepoDialog repo={null} onClose={() => setConnecting(false)} />}
    </>
  );
}

function RepoDetail({ repo }: { repo: Repo }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [rollback, setRollback] = useState<Deploy | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const deploy = useAction(() =>
    send('POST', '/api/v1/admin/git-repositories/{id}/deployments', {
      path: { id: repo.uuid },
      body: {},
    }),
  );
  const rotate = useAction(
    () =>
      send<{ secret: string }>(
        'POST',
        '/api/v1/admin/git-repositories/{id}:rotate-webhook-secret',
        {
          path: { id: repo.uuid },
          body: {},
        },
      ),
    { onSuccess: (r) => setSecret(r.secret) },
  );
  const disconnect = useAction(
    () => send('DELETE', '/api/v1/admin/git-repositories/{id}', { path: { id: repo.uuid } }),
    {
      success: t('git.disconnected'),
      invalidate: [['admin', 'git-repositories']],
      onSuccess: () => setDisconnecting(false),
    },
  );
  const doRollback = useAction(
    (d: Deploy) =>
      send('POST', '/api/v1/admin/git-deployments/{id}:rollback', {
        path: { id: d.uuid },
        body: {},
      }),
    { onSuccess: () => setRollback(null) },
  );
  const current = repo.current_deployment?.uuid;
  const columns: ColumnDef<Deploy, unknown>[] = [
    {
      id: 'commit',
      header: t('git.commit'),
      accessorKey: 'commit_sha',
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-sm">{row.original.commit_sha}</span>
            {row.original.uuid === current && <Badge tone="success">{t('git.current')}</Badge>}
          </span>
          <span className="text-sm break-words text-muted">
            {row.original.commit_message ?? '—'}
          </span>
        </div>
      ),
    },
    { id: 'trigger', header: t('git.trigger'), accessorFn: (d) => t(`git.triggers.${d.trigger}`) },
    {
      id: 'by',
      header: t('git.by'),
      accessorFn: (d) => d.requested_by?.name ?? d.commit_author ?? '—',
    },
    {
      id: 'at',
      header: t('git.at'),
      accessorFn: (d) => d.created_at,
      cell: ({ row }) => fmt.dateTime(row.original.created_at),
    },
    {
      id: 'state',
      header: t('sites.status'),
      accessorKey: 'state',
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-0.5">
          <StatusBadge status={row.original.state} />
          {row.original.job_uuid && (
            <AppLink
              href={`/admin/jobs/${row.original.job_uuid}`}
              className="text-xs hover:underline"
            >
              {t('git.viewJob')}
            </AppLink>
          )}
        </div>
      ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('git.actionsFor', { sha: row.original.commit_sha })}
          actions={[
            {
              label: t('git.rollback'),
              onSelect: () => setRollback(row.original),
              hidden:
                row.original.uuid === current ||
                (row.original.state !== 'succeeded' && row.original.state !== 'rolled_back'),
            },
          ]}
        />
      ),
    },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader
          title={repo.website.primary_domain}
          description={t('git.repoHint', { keep: repo.keep_releases })}
          action={
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => deploy.mutate()} disabled={deploy.isPending}>
                <Rocket aria-hidden />
                {t('git.deploy')}
              </Button>
              <RowMenu
                label={t('git.repoActions')}
                actions={[
                  { label: t('git.settings'), onSelect: () => setEditing(true) },
                  { label: t('git.rotate'), onSelect: () => rotate.mutate() },
                  {
                    label: t('git.disconnect'),
                    onSelect: () => setDisconnecting(true),
                    danger: true,
                  },
                ]}
              />
            </div>
          }
        />
        <CardContent className="grid gap-4 md:grid-cols-2">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">{t('git.repoUrl')}</dt>
            <dd className="font-mono break-all">{repo.repo_url}</dd>
            <dt className="text-muted">{t('git.branch')}</dt>
            <dd className="font-mono">{repo.branch}</dd>
            <dt className="text-muted">{t('git.autoDeploy')}</dt>
            <dd>{repo.auto_deploy ? t('sites.on') : t('sites.off')}</dd>
            <dt className="text-muted">{t('git.build')}</dt>
            <dd className="font-mono break-all">{repo.build_command ?? '—'}</dd>
            <dt className="text-muted">{t('git.shared')}</dt>
            <dd className="font-mono break-all">{repo.shared_paths.join(', ') || '—'}</dd>
          </dl>
          <div className="flex min-w-0 flex-col gap-3">
            <CodeBlock wrap code={repo.deploy_key_public} label={t('git.deployKey')} />
            <CodeBlock wrap code={repo.webhook_url} label={t('git.webhook')} />
          </div>
        </CardContent>
      </Card>
      <ListPage<Deploy>
        embedded
        search={false}
        title={t('git.history')}
        queryKey={['admin', 'git', repo.uuid, 'deployments']}
        fetch={() =>
          list('/api/v1/admin/git-repositories/{id}/deployments', undefined, {
            path: { id: repo.uuid },
          })
        }
        columns={columns}
        getRowId={(d) => d.uuid}
        primaryColumnId="commit"
        empty={<p className="p-6 text-center text-base text-muted">{t('git.noDeploys')}</p>}
      />
      {editing && <RepoDialog repo={repo} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={rollback !== null}
        onOpenChange={(o) => !o && setRollback(null)}
        tone="primary"
        title={t('git.rollbackTitle', { sha: rollback?.commit_sha ?? '' })}
        description={t('git.rollbackHint')}
        confirmLabel={t('git.rollback')}
        onConfirm={() =>
          rollback ? doRollback.mutateAsync(rollback).then(() => undefined) : undefined
        }
      />
      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={t('git.disconnectTitle', { name: repo.website.primary_domain })}
        description={t('git.disconnectHint')}
        confirmLabel={t('git.disconnect')}
        onConfirm={() => disconnect.mutateAsync().then(() => undefined)}
      />
      <SecretDialog secret={secret} title={t('git.newSecret')} onClose={() => setSecret(null)} />
    </div>
  );
}

function RepoDialog({ repo, onClose }: { repo: Repo | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const { sites } = useWebsites(undefined, repo === null);
  const { control, handleSubmit } = useForm<GitRepoForm>({
    resolver: zodResolver(gitRepoSchema),
    defaultValues: repo
      ? {
          website_uuid: repo.website.uuid,
          repo_url: repo.repo_url,
          branch: repo.branch,
          build_command: repo.build_command ?? '',
          shared_paths: repo.shared_paths.join('\n'),
          auto_deploy: repo.auto_deploy,
          keep_releases: repo.keep_releases,
        }
      : {
          website_uuid: '',
          repo_url: '',
          branch: 'main',
          build_command: '',
          shared_paths: '.env\nstorage',
          auto_deploy: false,
          keep_releases: 5,
        },
  });
  const save = useAction(
    (v: GitRepoForm) => {
      const common = {
        branch: v.branch,
        build_command: v.build_command || null,
        shared_paths: splitLines(v.shared_paths),
        auto_deploy: v.auto_deploy,
        keep_releases: v.keep_releases,
      };
      return repo
        ? send('PATCH', '/api/v1/admin/git-repositories/{id}', {
            path: { id: repo.uuid },
            body: common,
          })
        : send('POST', '/api/v1/admin/git-repositories', {
            body: { website_uuid: v.website_uuid, repo_url: v.repo_url, ...common },
          });
    },
    {
      success: repo ? t('git.saved') : t('git.connected'),
      invalidate: [['admin', 'git-repositories']],
      onSuccess: onClose,
    },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={
        repo ? t('git.settingsTitle', { name: repo.website.primary_domain }) : t('git.connectTitle')
      }
      description={t('git.connectHint')}
      submitLabel={repo ? t('git.save') : t('git.connect')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      {!repo && (
        <>
          <SelectField
            control={control}
            name="website_uuid"
            label={t('wp.site')}
            options={sites.map((w) => ({
              value: w.uuid,
              label: `${w.primary_domain} (${w.hosting_account.username})`,
            }))}
            placeholder={t('wp.pickSite')}
          />
          <TextField
            control={control}
            name="repo_url"
            label={t('git.repoUrl')}
            placeholder="git@github.com:itso/anphat-web.git"
            autoComplete="off"
          />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField control={control} name="branch" label={t('git.branch')} autoComplete="off" />
        <TextField control={control} name="keep_releases" type="number" label={t('git.keep')} />
      </div>
      <TextField
        control={control}
        name="build_command"
        label={t('git.build')}
        placeholder="composer install --no-dev && npm ci && npm run build"
        description={t('git.buildHint')}
        optional
      />
      <FormField
        control={control}
        name="shared_paths"
        label={t('git.shared')}
        description={t('git.sharedHint')}
        optional
        render={(f) => (
          <Textarea
            {...f}
            rows={3}
            className="font-mono text-sm"
            spellCheck={false}
            value={String(f.value ?? '')}
          />
        )}
      />
      <FormField
        control={control}
        name="auto_deploy"
        label={t('git.autoDeploy')}
        description={t('git.autoDeployHint')}
        render={(f) => (
          <Switch
            id={f.id}
            checked={f.value as boolean}
            onCheckedChange={f.onChange}
            aria-describedby={f['aria-describedby']}
          />
        )}
      />
    </FormDialog>
  );
}
