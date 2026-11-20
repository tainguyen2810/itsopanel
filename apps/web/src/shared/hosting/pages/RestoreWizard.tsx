import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ChoiceCard } from '@/shared/page/ChoiceCard';
import { InfoList } from '@/shared/page/InfoList';
import { Stepper } from '@/shared/page/Stepper';
import { Alert } from '@/ui/Alert';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent } from '@/ui/Card';
import { Checkbox } from '@/ui/Checkbox';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { get, list, send } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { normalizeItems } from '../backup';
import { VerifyBadge, type Snapshot } from './backup';
import { AccountSelect, Mono } from './common';

const STEPS = ['snapshot', 'items', 'mode', 'review'] as const;

/**
 * Wizard khôi phục (Admin và Portal): chọn snapshot → chọn nội dung → cách khôi phục → xác nhận.
 * `targetServers` (chỉ Admin) cho phép khôi phục ra bản mới trên server khác; Portal luôn khôi
 * phục trên server hiện tại của account.
 */
export function RestoreWizard({
  snapshot: initialSnapshot,
  targetServers,
  onDone,
}: {
  snapshot?: string | undefined;
  targetServers?: { value: string; label: string }[];
  onDone: () => void;
}) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [step, setStep] = useState(0);
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [snapshotId, setSnapshotId] = useState<string | undefined>(initialSnapshot);
  const [paths, setPaths] = useState<string[]>([]);
  const [mode, setMode] = useState<'new' | 'overwrite'>('new');
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const snaps = useQuery({
    queryKey: ['admin', 'backups', 'snapshots', 'wizard'],
    queryFn: () => list('/backup-snapshots'),
  });
  const accounts = useQuery({
    queryKey: ['admin', 'accounts', 'all'],
    queryFn: () => list('/hosting-accounts'),
  });
  const snapshot = snaps.data?.find((s) => s.uuid === snapshotId);
  const accountId = account ?? snapshot?.hosting_account?.uuid;
  const acc = accounts.data?.find((a) => a.uuid === accountId);
  const choices = (snaps.data ?? []).filter((s) => s.hosting_account?.uuid === accountId);
  const browse = (path: string, enabled: boolean) => ({
    queryKey: ['admin', 'backups', 'browse', snapshotId, path],
    queryFn: () =>
      get('/backup-snapshots/{id}/browse', {
        path: { id: snapshotId ?? '' },
        query: { path },
      }),
    enabled: enabled && snapshotId !== undefined,
  });
  const sites = useQuery(browse('sites', snapshot?.contents.includes('files') ?? false));
  const dumps = useQuery(browse('databases', snapshot?.contents.includes('databases') ?? false));
  const items = normalizeItems(paths);
  const targetId = target ?? acc?.server.uuid;
  const targetName =
    targetServers?.find((s) => s.value === targetId)?.label ?? acc?.server.name ?? '';

  const start = useAction(
    () =>
      send('POST', '/restores', {
        body: {
          snapshot_uuid: snapshotId,
          mode,
          items,
          target_server_uuid: mode === 'new' && targetServers ? (targetId ?? null) : null,
          confirm: mode === 'overwrite' ? confirm.trim() : null,
        },
      }),
    { onSuccess: onDone },
  );

  const check = (): string | null => {
    if (step === 0) return snapshot ? null : t('rs.errors.snapshot');
    if (step === 1) return items.length > 0 ? null : t('rs.errors.items');
    if (step === 2 && mode === 'overwrite' && confirm.trim() !== acc?.username)
      return t('rs.errors.confirm', { name: acc?.username ?? '' });
    return null;
  };
  const next = () => {
    const e = check();
    setError(e);
    if (!e) setStep(step + 1);
  };
  const toggle = (p: string, on: boolean) =>
    setPaths((cur) => (on ? [...cur, p] : cur.filter((x) => x !== p)));
  const pick = (path: string, label: string, hint?: string) => (
    <label
      key={path}
      className="flex items-start gap-2 rounded-md border border-border p-3 hover:bg-surface-hover"
    >
      <Checkbox
        className="mt-0.5"
        checked={paths.includes(path)}
        onCheckedChange={(c) => toggle(path, c === true)}
      />
      <span className="min-w-0">
        <span className="block font-medium break-all">{label}</span>
        {hint && <span className="text-sm text-muted">{hint}</span>}
      </span>
    </label>
  );

  const body = [
    <div key="s" className="flex flex-col gap-4">
      <AccountSelect
        id="rs-account"
        value={accountId}
        onChange={(v) => {
          setAccount(v);
          setSnapshotId(undefined);
          setPaths([]);
        }}
      />
      {accountId && choices.length === 0 && <Alert tone="warning" title={t('rs.noSnapshots')} />}
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t('rs.steps.snapshot')}</legend>
        {choices.map((s: Snapshot) => (
          <ChoiceCard
            key={s.uuid}
            name="snapshot"
            value={s.uuid}
            checked={snapshotId === s.uuid}
            onChange={(v) => {
              setSnapshotId(v);
              setPaths([]);
            }}
          >
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{fmt.dateTime(s.taken_at)}</span>
              <VerifyBadge s={s} />
            </span>
            <span className="mt-1 flex flex-wrap gap-x-3 text-sm text-muted">
              <span>{s.destination.name}</span>
              <span>{fmt.mb(s.size_mb)}</span>
              <span>{s.contents.map((c) => t(`bk.content.${c}`)).join(', ')}</span>
              <Mono>{s.restic_snapshot_id}</Mono>
            </span>
          </ChoiceCard>
        ))}
      </fieldset>
    </div>,
    <div key="i" className="flex flex-col gap-4">
      {snapshot?.contents.includes('files') && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">{t('rs.files')}</legend>
          {pick('sites', t('rs.allSites'), 'sites/')}
          <div className="grid gap-2 sm:grid-cols-2">
            {(sites.data ?? [])
              .filter((e) => e.type === 'dir')
              .map((e) => pick(e.path, e.name, `${e.path}/`))}
          </div>
        </fieldset>
      )}
      {snapshot?.contents.includes('databases') && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">{t('rs.databases')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(dumps.data ?? []).map((e) =>
              pick(e.path, e.name.replace(/\.sql\.zst$/, ''), fmt.bytes(e.size)),
            )}
          </div>
        </fieldset>
      )}
      {snapshot?.contents.includes('config') && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">{t('rs.config')}</legend>
          {pick('config', t('rs.configItem'), t('rs.configHint'))}
        </fieldset>
      )}
      {items.length > 0 && (
        <p className="text-sm text-muted">
          {t('rs.selected', { count: items.length })}: <Mono>{items.join(', ')}</Mono>
        </p>
      )}
    </div>,
    <div key="m" className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t('rs.mode')}</legend>
        {(['new', 'overwrite'] as const).map((m) => (
          <ChoiceCard
            key={m}
            name="mode"
            value={m}
            checked={mode === m}
            onChange={(v) => setMode(v as typeof mode)}
          >
            <span className="font-medium">{t(`rs.modes.${m}.title`)}</span>
            <span className="block text-sm text-muted">{t(`rs.modes.${m}.hint`)}</span>
          </ChoiceCard>
        ))}
      </fieldset>
      {mode === 'new' ? (
        targetServers && (
          <div className="flex max-w-sm flex-col gap-1.5">
            <Label htmlFor="rs-target">{t('rs.target')}</Label>
            <Select
              id="rs-target"
              value={targetId ?? ''}
              onValueChange={setTarget}
              options={targetServers.map((s) => ({
                value: s.value,
                label:
                  s.value === acc?.server.uuid ? t('rs.currentServer', { name: s.label }) : s.label,
              }))}
            />
            <p className="text-sm text-muted">{t('rs.targetHint')}</p>
          </div>
        )
      ) : (
        <>
          <Alert tone="danger" title={t('rs.overwriteWarn')}>
            {t('rs.overwriteHint')}
          </Alert>
          <div className="flex max-w-sm flex-col gap-1.5">
            <Label htmlFor="rs-confirm">
              {t('rs.confirmLabel', { name: acc?.username ?? '' })}
            </Label>
            <Input
              id="rs-confirm"
              value={confirm}
              autoComplete="off"
              aria-invalid={error !== null && step === 2}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        </>
      )}
    </div>,
    <div key="r" className="flex flex-col gap-4">
      <InfoList
        items={[
          [t('sites.account'), acc?.username ?? '—'],
          [
            t('rs.snapshot'),
            snapshot ? `${fmt.dateTime(snapshot.taken_at)} · ${snapshot.restic_snapshot_id}` : '—',
          ],
          [t('rs.items'), <Mono key="i">{items.join(', ')}</Mono>],
          [
            t('rs.mode'),
            <Badge key="m" tone={mode === 'overwrite' ? 'warning' : 'info'}>
              {t(`rs.modes.${mode}.title`)}
            </Badge>,
          ],
          ...(targetServers
            ? [
                [t('rs.target'), mode === 'new' ? targetName : (acc?.server.name ?? '')] as [
                  string,
                  string,
                ],
              ]
            : []),
        ]}
      />
      <Alert tone="info" title={t('rs.reviewTitle')}>
        {mode === 'overwrite' ? t('rs.reviewOverwrite') : t('rs.reviewNew')}
      </Alert>
    </div>,
  ];
  const last = step === STEPS.length - 1;
  return (
    <Card>
      <CardContent>
        <Stepper
          steps={STEPS.map((s) => t(`rs.steps.${s}`))}
          current={step}
          label={t('rs.wizard')}
          onSelect={(i) => {
            setError(null);
            setStep(i);
          }}
        />
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (last) start.mutate();
            else next();
          }}
        >
          <section aria-labelledby="rs-step" className="flex flex-col gap-4">
            <h2 id="rs-step" className="text-lg font-semibold">
              {t(`rs.steps.${STEPS[step] ?? 'snapshot'}`)}
            </h2>
            {body[step]}
            {error && (
              <p role="alert" className="text-sm text-danger-text">
                {error}
              </p>
            )}
          </section>
          <div className="flex justify-between gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}
            >
              <ArrowLeft aria-hidden />
              {t('rs.back')}
            </Button>
            {last ? (
              <Button
                key="submit"
                type="submit"
                variant={mode === 'overwrite' ? 'danger' : 'primary'}
                disabled={start.isPending}
              >
                <History aria-hidden />
                {t('rs.start')}
              </Button>
            ) : (
              <Button key="next" type="button" onClick={next}>
                {t('rs.next')}
                <ArrowRight aria-hidden />
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
