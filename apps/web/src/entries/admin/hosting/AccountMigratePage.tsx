import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  ShieldCheck,
  Trash2,
  Undo2,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { useSession } from '@/shared/session/SessionContext';
import { JobView } from '@/shared/jobs/JobDrawer';
import { InfoList } from '@/shared/page/InfoList';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton, TableSkeleton } from '@/shared/page/states';
import { Stepper } from '@/shared/page/Stepper';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import { Button, buttonVariants } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import type { components } from '@/api/generated/admin/schema';
import { get, list, send } from '../api';
import { useAction } from '../useAction';
import { daysLeft, MIGRATION_STEPS, migrationStep, type Account, type Migration } from './accounts';
import { useAccount } from './common';
import { Placement } from './Placement';

const RUNNING = new Set(['preflight', 'syncing', 'cutover']);
const OPEN = new Set(['preflight', 'syncing', 'verifying', 'cutover', 'holding']);

export default function AccountMigratePage() {
  const { t } = useTranslation('admin');
  const acc = useAccount();
  const migs = useQuery({
    queryKey: ['admin', 'account', acc.id, 'migrations'],
    queryFn: async () =>
      (await list('/api/v1/admin/account-migrations')).filter(
        (m) => m.hosting_account.uuid === acc.id,
      ),
    refetchInterval: (q) => (q.state.data?.some((m) => RUNNING.has(m.state)) ? 1000 : false),
  });
  // Đã bấm bắt đầu lại sau khi một lần chuyển kết thúc (hoàn tất/hoàn tác).
  const [fresh, setFresh] = useState(false);

  if (acc.isPending || migs.isPending) return <PageSkeleton />;
  if (acc.isError || migs.isError) {
    const e = acc.error ?? migs.error;
    return (
      <>
        <PageHeader title={t('migrate.title')} />
        <ErrorState error={e} onRetry={() => void (acc.isError ? acc.refetch() : migs.refetch())} />
      </>
    );
  }
  const a = acc.data;
  const current = migs.data.find((m) => OPEN.has(m.state)) ?? (fresh ? undefined : migs.data[0]);
  const step = migrationStep(current);
  const labels = MIGRATION_STEPS.map((s) => t(`migrate.steps.${s}`));
  return (
    <>
      <PageHeader
        title={t('migrate.titleFor', { name: a.username })}
        crumb={t('migrate.title')}
        description={t('migrate.description')}
      />
      <Card>
        <CardContent>
          <Stepper
            steps={labels}
            current={MIGRATION_STEPS.indexOf(step)}
            label={t('migrate.wizard')}
          />
          <section aria-labelledby="mig-step" className="flex flex-col gap-4">
            <h2 id="mig-step" className="text-lg font-semibold">
              {labels[MIGRATION_STEPS.indexOf(step)]}
            </h2>
            {step === 'preflight' && <Preflight a={a} onStart={() => setFresh(false)} />}
            {current && (step === 'sync' || step === 'cutover') && <Running m={current} />}
            {current && step === 'verify' && <Verify m={current} />}
            {current && step === 'holding' && <Holding m={current} />}
            {current && step === 'done' && (
              <Done m={current} a={a} onAgain={() => setFresh(true)} />
            )}
          </section>
        </CardContent>
      </Card>
    </>
  );
}

type Check = components['schemas']['MigrationPreflight'];

function Preflight({ a, onStart }: { a: Account; onStart: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [target, setTarget] = useState('');
  const [keep, setKeep] = useState(7);
  const [result, setResult] = useState<Check | null>(null);
  const servers = useQuery({
    queryKey: ['admin', 'placement', a.package.uuid],
    queryFn: () =>
      list('/api/v1/admin/placement/suggestions', undefined, {
        query: { package: a.package.uuid },
      }),
  });
  const inv = [['admin', 'account', a.uuid]];
  const check = useAction(
    () =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:migrate-preflight', {
        path: { id: a.uuid },
        body: { target_server_uuid: target },
      }),
    { onSuccess: (r) => setResult(r as Check) },
  );
  const start = useAction(
    () =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:migrate', {
        path: { id: a.uuid },
        body: { target_server_uuid: target, keep_source_days: keep },
      }),
    { invalidate: inv, onSuccess: onStart },
  );
  const keepOk = Number.isInteger(keep) && keep >= 1 && keep <= 30;
  const checked = result !== null && result.target_server.uuid === target;
  const ready = target !== '' && keepOk && checked && result.ok;
  return (
    <div className="flex flex-col gap-5">
      <p className="text-base text-muted">
        {t('migrate.preflightHint', { server: a.server.name })}
      </p>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">{t('migrate.target')}</legend>
        {servers.isPending ? (
          <TableSkeleton rows={2} />
        ) : (
          <Placement
            name="target"
            items={servers.data ?? []}
            value={target}
            onChange={(v) => {
              setTarget(v);
              setResult(null);
            }}
            exclude={a.server.uuid}
          />
        )}
      </fieldset>
      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="keep-days">{t('migrate.keepDays')}</Label>
        <Input
          id="keep-days"
          type="number"
          min={1}
          max={30}
          value={Number.isNaN(keep) ? '' : keep}
          onChange={(e) => setKeep(e.target.valueAsNumber)}
          aria-invalid={!keepOk}
          aria-describedby="keep-days-hint"
        />
        <p
          id="keep-days-hint"
          className={keepOk ? 'text-xs text-muted' : 'text-xs text-danger-text'}
        >
          {t('migrate.keepDaysHint')}
        </p>
      </div>
      {checked && (
        <Card>
          <CardHeader
            title={t('migrate.preflightResult', { server: result.target_server.name })}
            description={t('migrate.estimate', {
              size: fmt.bytes(result.estimate.bytes),
              seconds: result.estimate.downtime_sec,
            })}
          />
          <CardContent>
            <ul className="flex flex-col gap-2" aria-label={t('migrate.checks')}>
              {result.checks.map((c) => (
                <li key={c.key} className="flex items-start gap-2 text-base">
                  <LevelIcon level={c.level} />
                  <span>
                    <span className="sr-only">{t(`migrate.levels.${c.level}`)}: </span>
                    {c.message}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {checked && !result.ok && (
        <Alert tone="danger" title={t('migrate.blocked')}>
          {t('migrate.blockedHint')}
        </Alert>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          disabled={target === '' || check.isPending}
          onClick={() => check.mutate()}
        >
          <ShieldCheck aria-hidden />
          {t('migrate.runPreflight')}
        </Button>
        <Button disabled={!ready || start.isPending} onClick={() => start.mutate()}>
          <ArrowLeftRight aria-hidden />
          {t('migrate.start')}
        </Button>
      </div>
    </div>
  );
}

function LevelIcon({ level }: { level: 'ok' | 'warn' | 'block' }) {
  const cls = 'mt-0.5 size-4 shrink-0';
  if (level === 'ok') return <CheckCircle2 aria-hidden className={`${cls} text-success`} />;
  if (level === 'warn') return <AlertTriangle aria-hidden className={`${cls} text-warning`} />;
  return <XCircle aria-hidden className={`${cls} text-danger`} />;
}

function Running({ m }: { m: Migration }) {
  const { t } = useTranslation('admin');
  const job = useQuery({
    queryKey: ['job', m.job_uuid],
    enabled: m.job_uuid !== null,
    queryFn: () => get('/api/v1/admin/jobs/{id}', { path: { id: m.job_uuid as string } }),
    refetchInterval: 800,
  });
  return (
    <div className="flex flex-col gap-4">
      <InfoList
        items={[
          [t('migrate.from'), m.source_server.name],
          [t('migrate.to'), m.target_server.name],
          [t('migrate.state'), <StatusBadge key="s" status={m.state} />],
        ]}
      />
      {m.state === 'cutover' && (
        <p role="status" className="text-base text-muted">
          {t('migrate.cutoverRunning')}
        </p>
      )}
      {job.data?.state === 'waiting_agent' && (
        <Alert tone="warning" title={t('migrate.waitingNode')}>
          {t('migrate.waitingNodeHint')}
        </Alert>
      )}
      {job.data && (
        <JobView
          job={job.data}
          title={m.state === 'cutover' ? t('migrate.cutover') : t('migrate.syncJob')}
        />
      )}
    </div>
  );
}

function Verify({ m }: { m: Migration }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [confirm, setConfirm] = useState<'cutover' | 'rollback' | null>(null);
  const inv = [['admin', 'account', m.hosting_account.uuid]];
  const cutover = useAction(
    () =>
      send('POST', '/api/v1/admin/account-migrations/{id}:cutover', {
        path: { id: m.uuid },
        body: {},
      }),
    { invalidate: inv },
  );
  const rollback = useAction(
    () =>
      send('POST', '/api/v1/admin/account-migrations/{id}:rollback', {
        path: { id: m.uuid },
        body: {},
      }),
    { invalidate: inv },
  );
  const bad = m.verification.length === 0 || m.verification.some((c) => !c.ok);
  return (
    <div className="flex flex-col gap-4">
      {bad ? (
        <Alert tone="danger" title={t('migrate.mismatch', { server: m.target_server.name })}>
          {m.error ?? t('migrate.mismatchHint')}
        </Alert>
      ) : (
        <Alert tone="success" title={t('migrate.verified', { server: m.target_server.name })}>
          {t('migrate.verifiedHint', { size: fmt.bytes(m.bytes_synced) })}
        </Alert>
      )}
      <Card>
        <CardHeader title={t('migrate.checks')} />
        <CardContent>
          <ul className="flex flex-col gap-2">
            {m.verification.map((c) => (
              <li key={`${c.kind}:${c.name}`} className="flex items-start gap-2 text-base">
                <LevelIcon level={c.ok ? 'ok' : 'block'} />
                <span>
                  <span className="font-medium">
                    {t(`migrate.check.${c.kind}`)} · {c.name}
                  </span>
                  <span className="text-muted">: {c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button variant="outline" onClick={() => setConfirm('rollback')}>
          <Undo2 aria-hidden />
          {t('migrate.rollback')}
        </Button>
        <Button
          disabled={bad}
          aria-describedby={bad ? 'cutover-blocked' : undefined}
          onClick={() => setConfirm('cutover')}
        >
          <ArrowLeftRight aria-hidden />
          {t('migrate.cutover')}
        </Button>
      </div>
      {bad && (
        <p id="cutover-blocked" className="text-right text-sm text-muted">
          {t('migrate.mismatchHint')}
        </p>
      )}
      <ConfirmDialog
        open={confirm === 'cutover'}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="primary"
        title={t('migrate.cutoverTitle', { server: m.target_server.name })}
        description={
          <span className="flex flex-col gap-2">
            <span>{t('migrate.cutoverHint', { seconds: m.downtime_estimate_sec ?? 60 })}</span>
            {m.dns && <DnsPlan dns={m.dns} />}
            <span className="text-muted">{t('migrate.tlsNote')}</span>
          </span>
        }
        confirmName={m.hosting_account.username}
        confirmLabel={t('migrate.cutover')}
        disabled={bad}
        onConfirm={() => cutover.mutateAsync().then(() => undefined)}
      />
      <ConfirmDialog
        open={confirm === 'rollback'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('migrate.rollbackTitle')}
        description={t('migrate.rollbackHint', { server: m.source_server.name })}
        confirmLabel={t('migrate.rollback')}
        onConfirm={() => rollback.mutateAsync().then(() => undefined)}
      />
    </div>
  );
}

function DnsPlan({ dns }: { dns: NonNullable<Migration['dns']> }) {
  const { t } = useTranslation('admin');
  return (
    <span className="flex flex-col gap-1">
      <span className="font-medium">
        {dns.mode === 'auto'
          ? t('migrate.dnsAuto', { zone: dns.zone ?? '' })
          : t('migrate.dnsManual')}
      </span>
      {dns.records.map((r) => (
        <code key={`${r.type}:${r.name}`} className="font-mono text-sm">
          {r.name} {r.type} {r.value}
        </code>
      ))}
    </span>
  );
}

function Holding({ m }: { m: Migration }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [confirm, setConfirm] = useState<'cleanup' | 'rollback' | null>(null);
  const inv = [['admin', 'account', m.hosting_account.uuid]];
  const cleanup = useAction(
    () =>
      send('POST', '/api/v1/admin/account-migrations/{id}:cleanup', {
        path: { id: m.uuid },
        body: { confirm_username: m.hosting_account.username },
      }),
    { invalidate: inv },
  );
  const rollback = useAction(
    () =>
      send('POST', '/api/v1/admin/account-migrations/{id}:rollback', {
        path: { id: m.uuid },
        body: {},
      }),
    { invalidate: inv },
  );
  const left = daysLeft(m.cleanup_after) ?? 0;
  const { user } = useSession();
  const early = m.cleanup_after !== null && left > 0;
  const canClean = !early || user.role === 'SUPER_ADMIN';
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="success" title={t('migrate.running', { server: m.target_server.name })}>
        {t('migrate.holdingHint', {
          server: m.source_server.name,
          count: left,
          date: fmt.opt(m.cleanup_after),
        })}{' '}
        {t('migrate.tlsNote')}
      </Alert>
      <InfoList
        items={[
          [t('migrate.from'), m.source_server.name],
          [t('migrate.to'), m.target_server.name],
          [t('migrate.state'), <StatusBadge key="s" status={m.state} />],
          [t('migrate.cutoverAt'), fmt.opt(m.cutover_at)],
          [t('migrate.downtime'), t('migrate.seconds', { count: m.downtime_sec ?? 0 })],
          [t('migrate.cleanupAt'), fmt.opt(m.cleanup_after)],
          ...(m.dns
            ? ([[t('migrate.dns'), <DnsPlan key="dns" dns={m.dns} />]] as [string, ReactNode][])
            : []),
        ]}
      />
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button variant="outline" onClick={() => setConfirm('rollback')}>
          <Undo2 aria-hidden />
          {t('migrate.rollback')}
        </Button>
        <Button
          variant="danger"
          disabled={!canClean}
          aria-describedby={canClean ? undefined : 'cleanup-early'}
          onClick={() => setConfirm('cleanup')}
        >
          <Trash2 aria-hidden />
          {t('migrate.cleanupNow')}
        </Button>
      </div>
      {!canClean && (
        <p id="cleanup-early" className="text-right text-sm text-muted">
          {t('migrate.earlyOnlySa', { date: fmt.opt(m.cleanup_after) })}
        </p>
      )}
      <ConfirmDialog
        open={confirm === 'cleanup'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('migrate.cleanupTitle', { server: m.source_server.name })}
        description={t('migrate.cleanupHint', { server: m.source_server.name })}
        confirmName={m.hosting_account.username}
        confirmLabel={t('migrate.cleanupNow')}
        onConfirm={() => cleanup.mutateAsync().then(() => undefined)}
      />
      <ConfirmDialog
        open={confirm === 'rollback'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('migrate.rollbackTitle')}
        description={t('migrate.rollbackHoldingHint', { server: m.source_server.name })}
        confirmName={m.hosting_account.username}
        confirmLabel={t('migrate.rollback')}
        onConfirm={() => rollback.mutateAsync().then(() => undefined)}
      />
    </div>
  );
}

function Done({ m, a, onAgain }: { m: Migration; a: Account; onAgain: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [confirm, setConfirm] = useState(false);
  const ok = m.state === 'completed';
  const failed = m.state === 'failed';
  // Lỗi từ cutover trở đi: account vẫn `migrating` (nguồn khóa) → phải hoàn tác; lỗi trước cutover: đã chạy lại ở nguồn.
  const locked = failed && a.lifecycle_state === 'migrating';
  const rollback = useAction(
    () =>
      send('POST', '/api/v1/admin/account-migrations/{id}:rollback', {
        path: { id: m.uuid },
        body: {},
      }),
    { invalidate: [['admin', 'account', a.uuid]] },
  );
  return (
    <div className="flex flex-col gap-4">
      <Alert
        tone={ok ? 'success' : failed ? 'danger' : 'info'}
        title={
          ok
            ? t('migrate.completed', { server: m.target_server.name })
            : failed
              ? t('migrate.failed')
              : t('migrate.ended', { state: m.state })
        }
      >
        {ok
          ? t('migrate.completedHint', { seconds: m.downtime_sec ?? 0 })
          : failed
            ? `${m.error ?? ''} ${locked ? t('migrate.failedLocked', { server: m.source_server.name }) : t('migrate.failedActive', { server: m.source_server.name })}`.trim()
            : t('migrate.rolledBackHint', { server: m.source_server.name })}
      </Alert>
      <InfoList
        items={[
          [t('migrate.from'), m.source_server.name],
          [t('migrate.to'), m.target_server.name],
          [t('migrate.state'), <StatusBadge key="s" status={m.state} />],
          [t('migrate.requestedBy'), m.requested_by.name],
          [t('migrate.updatedAt'), fmt.dateTime(m.updated_at)],
        ]}
      />
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        {failed && (
          <Button variant={locked ? 'primary' : 'outline'} onClick={() => setConfirm(true)}>
            <Undo2 aria-hidden />
            {t('migrate.rollback')}
          </Button>
        )}
        {!locked && (
          <Button variant="outline" onClick={onAgain}>
            {t('migrate.again')}
          </Button>
        )}
        <AppLink href={`/admin/hosting-accounts/${a.uuid}`} className={buttonVariants()}>
          {t('migrate.backToAccount')}
        </AppLink>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('migrate.rollbackTitle')}
        description={t('migrate.rollbackHint', { server: m.source_server.name })}
        confirmLabel={t('migrate.rollback')}
        onConfirm={() => rollback.mutateAsync().then(() => undefined)}
      />
    </div>
  );
}
