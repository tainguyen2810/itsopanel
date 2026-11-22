import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock, Package } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState } from '@/shared/page/states';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Skeleton } from '@/ui/Feedback';
import { get, list, send, type Data, type Row } from '../api';
import { useAction } from '../useAction';
import { ServerNav, useServer } from './common';

type Software = Row<'/api/v1/admin/servers/{id}/software'>;
type OsUpdates = Data<'/api/v1/admin/servers/{id}/os-updates'>;
type Action = 'install' | 'upgrade' | 'remove';

/** Thứ tự nhóm trong catalog (dạng app store nội bộ). */
export const CATEGORY_ORDER = [
  'web',
  'php',
  'database',
  'cache',
  'runtime',
  'tools',
  'docker',
  'security',
  'base',
] as const;

/** Hành động hợp lệ theo trạng thái phần mềm. Gỡ bị chặn (lõi, đang dùng) vẫn hiện nhưng tắt kèm lý do. */
export function softwareActions(s: Pick<Software, 'state'>): Action[] {
  switch (s.state) {
    case 'available':
    case 'failed':
      return ['install'];
    case 'upgradable':
      return ['upgrade', 'remove'];
    case 'installed':
      return ['remove'];
    default:
      return [];
  }
}

/** Phần mềm đang cài xung đột với `s` (vd Redis ↔ Valkey): chặn cài. */
export function conflictWith(s: Software, all: Software[]): Software | undefined {
  return all.find((x) => s.conflicts.includes(x.key) && x.installed_version !== null);
}

export default function ServerSoftwarePage() {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const server = useServer();
  const sa = user.role === 'SUPER_ADMIN';
  const q = useQuery({
    queryKey: ['admin', 'server', server.id, 'software'],
    queryFn: () =>
      list('/api/v1/admin/servers/{id}/software', undefined, { path: { id: server.id } }),
  });
  const [confirm, setConfirm] = useState<{ sw: Software; action: Action } | null>(null);
  const run = useAction(
    (v: { key: string; action: Action }) =>
      send('POST', '/api/v1/admin/servers/{id}/software/{key}:{action}', {
        path: { id: server.id, ...v },
      }),
    { invalidate: [['admin', 'server', server.id]], onSuccess: () => setConfirm(null) },
  );
  const rows = q.data ?? [];
  return (
    <>
      <PageHeader
        nav={<ServerNav current="software" />}
        title={t('software.title')}
        description={t('software.description')}
      />
      <div className="flex flex-col gap-6">
        <OsUpdatesCard id={server.id} canEdit={sa} />
        {q.isPending ? (
          <Skeleton className="h-64" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          CATEGORY_ORDER.filter((c) => rows.some((s) => s.category === c)).map((cat) => (
            <section key={cat} aria-labelledby={`sw-${cat}`} className="flex flex-col gap-3">
              <h2 id={`sw-${cat}`} className="text-md font-semibold">
                {t(`software.categories.${cat}`)}
              </h2>
              <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {rows
                  .filter((s) => s.category === cat)
                  .map((s) => (
                    <li key={s.key}>
                      <SoftwareCard
                        sw={s}
                        all={rows}
                        canEdit={sa}
                        onAction={(action) => setConfirm({ sw: s, action })}
                      />
                    </li>
                  ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone={confirm?.action === 'remove' ? 'danger' : 'primary'}
        title={confirm ? t(`software.confirm.${confirm.action}`, { name: confirm.sw.name }) : ''}
        description={
          confirm
            ? confirm.sw.source === 'ppa-ondrej-php' && confirm.action === 'install'
              ? t('software.ppaHint')
              : t(`software.confirmHint.${confirm.action}`)
            : ''
        }
        confirmLabel={confirm ? t(`software.actions.${confirm.action}`) : ''}
        onConfirm={() =>
          confirm
            ? run.mutateAsync({ key: confirm.sw.key, action: confirm.action }).then(() => undefined)
            : undefined
        }
      />
    </>
  );
}

function SoftwareCard({
  sw,
  all,
  canEdit,
  onAction,
}: {
  sw: Software;
  all: Software[];
  canEdit: boolean;
  onAction: (a: Action) => void;
}) {
  const { t } = useTranslation('admin');
  const conflict = conflictWith(sw, all);
  const missing = sw.requires.filter(
    (k) => !all.some((x) => x.key === k && x.installed_version !== null),
  );
  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Package aria-hidden className="size-4 text-muted" />
            {sw.name}
          </span>
        }
        description={<span className="font-mono">{sw.key}</span>}
        action={<StatusBadge status={sw.state} />}
      />
      <CardContent className="flex flex-1 flex-col gap-3">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted">{t('software.installed')}</dt>
          <dd className="tabular-nums">{sw.installed_version ?? '—'}</dd>
          <dt className="text-muted">{t('software.latest')}</dt>
          <dd className="tabular-nums">{sw.latest_version}</dd>
          <dt className="text-muted">{t('software.source')}</dt>
          <dd>
            <Badge tone={sw.source === 'ubuntu' ? 'neutral' : 'info'}>
              {t(`software.sources.${sw.source}`)}
            </Badge>
          </dd>
          {sw.service && (
            <>
              <dt className="text-muted">{t('software.service')}</dt>
              <dd className="flex items-center gap-1.5">
                <span className="font-mono">{sw.service.name}</span>
                <Badge tone={sw.service.active ? 'success' : 'danger'}>
                  {sw.service.active ? t('software.running') : t('software.stopped')}
                </Badge>
              </dd>
            </>
          )}
        </dl>
        {sw.in_use.length > 0 && (
          <p className="text-sm text-muted">
            {t('software.usedBy')}{' '}
            {sw.in_use.map((u) => t(`software.use.${u.kind}`, { count: u.count })).join(' · ')}
          </p>
        )}
        {conflict && sw.installed_version === null && (
          <Alert tone="warning" title={t('software.conflict', { name: conflict.name })} />
        )}
        {missing.length > 0 && sw.installed_version === null && (
          <p className="text-sm text-warning-text">
            {t('software.requires', { keys: missing.join(', ') })}
          </p>
        )}
        {canEdit && (
          <div className="mt-auto flex flex-col gap-2 pt-1">
            <div className="flex flex-wrap gap-2">
              {softwareActions(sw).map((a) => {
                const blocked =
                  a === 'remove'
                    ? sw.remove_blocked
                    : a === 'install' && conflict
                      ? t('software.conflict', { name: conflict.name })
                      : null;
                return (
                  <Button
                    key={a}
                    size="sm"
                    variant={a === 'remove' ? 'outline' : 'primary'}
                    disabled={blocked !== null}
                    aria-describedby={blocked ? `sw-block-${sw.key}` : undefined}
                    onClick={() => onAction(a)}
                  >
                    {t(`software.actions.${a}`)}
                  </Button>
                );
              })}
            </div>
            {sw.remove_blocked && sw.installed_version !== null && (
              <p id={`sw-block-${sw.key}`} className="flex items-start gap-1.5 text-sm text-muted">
                <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {sw.remove_blocked}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OsUpdatesCard({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'server', id, 'os-updates'],
    queryFn: () => get('/api/v1/admin/servers/{id}/os-updates', { path: { id } }),
  });
  const save = useAction(
    (v: Pick<OsUpdates, 'enabled' | 'security_only'>) =>
      send('PUT', '/api/v1/admin/servers/{id}/os-updates', { path: { id }, body: v }),
    { invalidate: [['admin', 'server', id, 'os-updates']] },
  );
  if (q.isPending) return <Skeleton className="h-28" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const o = q.data;
  return (
    <Card>
      <CardHeader
        title={t('software.os.title')}
        description={t('software.os.description')}
        action={
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={o.enabled}
              disabled={!canEdit || save.isPending}
              onCheckedChange={(v) => save.mutate({ enabled: v, security_only: o.security_only })}
              aria-label={t('software.os.toggle')}
            />
            {o.enabled ? t('software.os.on') : t('software.os.off')}
          </label>
        }
      />
      <CardContent className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>{o.security_only ? t('software.os.securityOnly') : t('software.os.allUpdates')}</span>
        <span>{t('software.os.pending', { count: o.pending_security })}</span>
        <span>
          {t('software.os.lastRun')}: {o.last_run_at ? fmt.dateTime(o.last_run_at) : '—'}
        </span>
        <span className="text-muted">{t('software.os.noReboot')}</span>
      </CardContent>
    </Card>
  );
}
