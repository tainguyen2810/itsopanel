import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, CheckCircle2, FlaskConical, Undo2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
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
import { get, list, send } from '../api';
import { useAction } from '../useAction';
import { ChoiceCard } from './AccountNewPage';
import { MIGRATION_STEPS, migrationStep, type Account, type Migration } from './accounts';
import { useAccount } from './common';

const RUNNING = new Set(['preflight', 'syncing', 'cutover']);
const OPEN = new Set(['preflight', 'syncing', 'verifying', 'cutover']);

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
            {current && step === 'done' && (
              <Done m={current} a={a} onAgain={() => setFresh(true)} />
            )}
          </section>
        </CardContent>
      </Card>
    </>
  );
}

function Preflight({ a, onStart }: { a: Account; onStart: () => void }) {
  const { t } = useTranslation('admin');
  const [target, setTarget] = useState('');
  const [strategy, setStrategy] = useState<'live_sync' | 'offline'>('live_sync');
  const [keep, setKeep] = useState(7);
  const servers = useQuery({
    queryKey: ['admin', 'placement', a.package.uuid],
    queryFn: () =>
      list('/api/v1/admin/placement/suggestions', undefined, {
        query: { package: a.package.uuid },
      }),
  });
  const body = (dry: boolean) => ({
    target_server_uuid: target,
    strategy,
    keep_source_days: keep,
    dry_run: dry,
  });
  const inv = [['admin', 'account', a.uuid]];
  const dry = useAction(
    () =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:migrate', {
        path: { id: a.uuid },
        body: body(true),
      }),
    {},
  );
  const start = useAction(
    () =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:migrate', {
        path: { id: a.uuid },
        body: body(false),
      }),
    { invalidate: inv, onSuccess: onStart },
  );
  const keepOk = Number.isInteger(keep) && keep >= 1 && keep <= 30;
  const ready = target !== '' && keepOk;
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
          (servers.data ?? [])
            .filter((s) => s.server.uuid !== a.server.uuid)
            .map((s) => (
              <ChoiceCard
                key={s.server.uuid}
                name="target"
                value={s.server.uuid}
                checked={target === s.server.uuid}
                disabled={!s.accepting_new}
                onChange={setTarget}
              >
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {s.server.name}
                  <span className="text-sm font-normal text-muted">
                    {t('accounts.score', { score: s.score })}
                  </span>
                </span>
                <span className="block text-sm text-muted">{s.reasons.join(' · ')}</span>
              </ChoiceCard>
            ))
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">{t('migrate.strategy')}</legend>
        <div className="grid gap-2 md:grid-cols-2">
          {(['live_sync', 'offline'] as const).map((s) => (
            <ChoiceCard
              key={s}
              name="strategy"
              value={s}
              checked={strategy === s}
              onChange={() => setStrategy(s)}
            >
              <span className="font-medium">{t(`migrate.strategies.${s}`)}</span>
              <span className="block text-sm text-muted">{t(`migrate.strategyHints.${s}`)}</span>
            </ChoiceCard>
          ))}
        </div>
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
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
        <Button variant="outline" disabled={!ready || dry.isPending} onClick={() => dry.mutate()}>
          <FlaskConical aria-hidden />
          {t('migrate.dryRun')}
        </Button>
        <Button disabled={!ready || start.isPending} onClick={() => start.mutate()}>
          <ArrowLeftRight aria-hidden />
          {t('migrate.start')}
        </Button>
      </div>
    </div>
  );
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
  const checks = Object.entries(m.verification as Record<string, unknown>);
  const show = (v: unknown) =>
    typeof v === 'string'
      ? v
      : typeof v === 'object' && v !== null && 'checked' in v
        ? t('migrate.filesChecked', {
            checked: fmt.num((v as unknown as { checked: number }).checked),
            mismatched: (v as unknown as { mismatched: number }).mismatched,
          })
        : Object.entries(v as Record<string, string>)
            .map(([k, x]) => `${k}: ${x}`)
            .join(', ');
  return (
    <div className="flex flex-col gap-4">
      <Alert tone="success" title={t('migrate.verified', { server: m.target_server.name })}>
        {t('migrate.verifiedHint', { size: fmt.bytes(m.bytes_synced) })}
      </Alert>
      <Card>
        <CardHeader title={t('migrate.checks')} />
        <CardContent>
          <ul className="flex flex-col gap-2">
            {checks.map(([k, v]) => (
              <li key={k} className="flex items-start gap-2 text-base">
                <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                <span>
                  <span className="font-medium">
                    {t(`migrate.check.${k}` as never, { defaultValue: k })}
                  </span>
                  <span className="text-muted">: {show(v)}</span>
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
        <Button onClick={() => setConfirm('cutover')}>
          <ArrowLeftRight aria-hidden />
          {t('migrate.cutover')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirm === 'cutover'}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="primary"
        title={t('migrate.cutoverTitle', { server: m.target_server.name })}
        description={t('migrate.cutoverHint')}
        confirmName={m.hosting_account.username}
        confirmLabel={t('migrate.cutover')}
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

function Done({ m, a, onAgain }: { m: Migration; a: Account; onAgain: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const ok = m.state === 'completed';
  return (
    <div className="flex flex-col gap-4">
      <Alert
        tone={ok ? 'success' : m.state === 'failed' ? 'danger' : 'info'}
        title={
          ok
            ? t('migrate.completed', { server: m.target_server.name })
            : t('migrate.ended', { state: m.state })
        }
      >
        {ok
          ? t('migrate.completedHint', {
              seconds: m.downtime_sec ?? 0,
              date: fmt.opt(m.cleanup_after),
            })
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
        <Button variant="outline" onClick={onAgain}>
          {t('migrate.again')}
        </Button>
        <AppLink href={`/admin/hosting-accounts/${a.uuid}`} className={buttonVariants()}>
          {t('migrate.backToAccount')}
        </AppLink>
      </div>
    </div>
  );
}
