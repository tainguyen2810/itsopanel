import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, DatabaseBackup, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { errorText } from '@/shared/api/useAction';
import { useFmt } from '@/shared/format/useFmt';
import { JobView } from '@/shared/jobs/JobDrawer';
import { AuthLayout } from '@/shared/page/AuthLayout';
import { ChoiceCard } from '@/shared/page/ChoiceCard';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { Button } from '@/ui/Button';
import { CodeBlock } from '@/ui/CodeBlock';
import { Input, Textarea } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import type { components } from '@/api/generated/admin/schema';
import { get, send } from '../api';
import { DEST_FIELDS, type DestType } from '../backups/forms';

type Candidate = components['schemas']['SetupRestoreCandidate'];
type Source = components['schemas']['SetupRestoreSource'];
type Stage = 'source' | 'pick' | 'run';

/**
 * Khôi phục thảm họa từ wizard cài đặt (D-87): máy chủ mới cài bằng `install.sh --restore`, SA nhập đích
 * + mật khẩu repo panel + khóa riêng từ bộ khôi phục → chọn bản backup panel → agent khôi phục DB panel +
 * /etc/itso rồi `itso repair` áp lại desired state. Không lưu credential/mật khẩu/khóa trên trình duyệt.
 */
export function DrRestore({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const fmt = useFmt();
  const ids = useId();
  const [stage, setStage] = useState<Stage>('source');
  const [type, setType] = useState<DestType>('s3');
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [jobUuid, setJobUuid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fields = DEST_FIELDS[type];
  const source = (): Source => ({
    type,
    config: Object.fromEntries(
      fields.config.filter((k) => cfg[k]?.trim()).map((k) => [k, (cfg[k] ?? '').trim()]),
    ),
    credentials: Object.fromEntries(
      fields.secret.filter((k) => cfg[k]).map((k) => [k, cfg[k] ?? '']),
    ),
    repository_password: password,
    panel_private_key: privateKey.trim(),
  });

  const job = useQuery({
    queryKey: ['setup', 'restore-job', jobUuid],
    queryFn: () => get('/api/v1/admin/jobs/{id}', { path: { id: jobUuid as string } }),
    enabled: jobUuid !== null,
    refetchInterval: (q) =>
      q.state.data && ['succeeded', 'failed', 'cancelled'].includes(q.state.data.state)
        ? false
        : 1000,
  });

  const run = async (fn: () => Promise<void>) => {
    setFailure(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setFailure(errorText(e, tc));
    } finally {
      setBusy(false);
    }
  };
  const inspect = () =>
    run(async () => {
      const r = await send<Candidate[]>('POST', '/api/v1/admin/setup/restore:inspect', {
        body: source(),
      });
      setCandidates(r);
      setPicked(r[0]?.snapshot_id);
      setStage('pick');
    });
  const start = () =>
    run(async () => {
      const r = await send<{ job: { uuid: string } }>('POST', '/api/v1/admin/setup/restore', {
        body: { source: source(), snapshot_id: picked },
      });
      setJobUuid(r.job.uuid);
      setStage('run');
    });

  const done = job.data?.state === 'succeeded';
  return (
    <AuthLayout title={t('install.dr.title')} area={t('auth.adminArea')} wide>
      <div className="flex flex-col gap-4">
        <p className="text-base">{t(`install.dr.${stage}Hint`)}</p>
        {failure && <Alert tone="danger" title={failure} />}

        {stage === 'source' && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-type`}>{t('bk.type')}</Label>
              <Select
                id={`${ids}-type`}
                value={type}
                onValueChange={(v) => setType(v as DestType)}
                options={(Object.keys(DEST_FIELDS) as DestType[]).map((k) => ({
                  value: k,
                  label: t(`bk.types.${k}`),
                }))}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[...fields.config, ...fields.secret].map((k) => (
                <div key={k} className="flex flex-col gap-1.5">
                  <Label htmlFor={`${ids}-${k}`}>{t(`bk.cfg.${k}`)}</Label>
                  <Input
                    id={`${ids}-${k}`}
                    type={(fields.secret as readonly string[]).includes(k) ? 'password' : 'text'}
                    autoComplete="off"
                    value={cfg[k] ?? ''}
                    onChange={(e) => setCfg((c) => ({ ...c, [k]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            {type === 'sftp' && <Alert tone="info" title={t('install.dr.sftpHint')} />}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-pw`}>{t('install.dr.repoPassword')}</Label>
              <Input
                id={`${ids}-pw`}
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-key`}>{t('install.dr.privateKey')}</Label>
              <Textarea
                id={`${ids}-key`}
                rows={2}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder="AGE-SECRET-KEY-1…"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
              />
              <p className="text-sm text-muted">{t('install.dr.privateKeyHint')}</p>
            </div>
          </>
        )}

        {stage === 'pick' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t('install.dr.pickLegend')}</legend>
            {candidates.map((c, i) => (
              <ChoiceCard
                key={c.snapshot_id}
                name="dr-snapshot"
                value={c.snapshot_id}
                checked={picked === c.snapshot_id}
                onChange={setPicked}
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{fmt.dateTime(c.taken_at)}</span>
                  {i === 0 && (
                    <span className="text-sm text-success-text">{t('install.dr.latest')}</span>
                  )}
                </span>
                <span className="mt-1 flex flex-wrap gap-x-3 text-sm text-muted">
                  <span>{c.hostname}</span>
                  <span>{t('install.dr.version', { v: c.panel_version })}</span>
                  <span>{t('install.dr.accounts', { count: c.accounts })}</span>
                  <span>{fmt.mb(c.size_mb)}</span>
                  <span className="font-mono">{c.snapshot_id}</span>
                </span>
              </ChoiceCard>
            ))}
            <Alert tone="warning" title={t('install.dr.pickWarnTitle')}>
              {t('install.dr.pickWarn')}
            </Alert>
          </fieldset>
        )}

        {stage === 'run' && (
          <>
            {job.data && <JobView job={job.data} title={t('install.dr.job')} />}
            {done && (
              <Alert tone="success" title={t('install.dr.doneTitle')}>
                {t('install.dr.doneHint')}
              </Alert>
            )}
            {done && <CodeBlock code="sudo itso repair --check" label={t('install.dr.verify')} />}
            {done && (
              <AppLink href="/login" className="font-medium text-primary-text hover:underline">
                {t('install.toLogin')}
              </AppLink>
            )}
          </>
        )}

        {stage !== 'run' && (
          <div className="mt-2 flex justify-between gap-2 border-t border-border pt-4">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => (stage === 'pick' ? setStage('source') : onBack())}
            >
              <ChevronLeft aria-hidden />
              {t('install.back')}
            </Button>
            {stage === 'source' ? (
              <Button disabled={busy} onClick={() => void inspect()}>
                <FolderOpen aria-hidden />
                {t('install.dr.open')}
              </Button>
            ) : (
              <Button disabled={busy || !picked} onClick={() => void start()}>
                <DatabaseBackup aria-hidden />
                {t('install.dr.start')}
              </Button>
            )}
          </div>
        )}
      </div>
    </AuthLayout>
  );
}
