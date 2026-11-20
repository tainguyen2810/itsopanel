import { useId, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronLeft, ChevronRight, Rocket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '@/shared/lib/utils';
import { AuthLayout } from '@/shared/page/AuthLayout';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Checkbox, Switch } from '@/ui/Checkbox';
import { CodeBlock } from '@/ui/CodeBlock';
import { Input, Textarea } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { ProgressBar } from '@/ui/ProgressBar';
import { Select } from '@/ui/Select';
import {
  allowlistLines,
  firstInvalid,
  INITIAL,
  STEPS,
  validate,
  warnings,
  type InstallState,
  type Step,
} from './wizard';

type Errors = Partial<Record<keyof InstallState, string>>;

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  children: (p: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const { t } = useTranslation('admin');
  const id = useId();
  const describedBy = [hint ? `${id}-h` : null, error ? `${id}-e` : null].filter(Boolean).join(' ');
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        'aria-invalid': error !== undefined,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
      })}
      {hint && (
        <p id={`${id}-h`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-e`} role="alert" className="text-xs text-danger-text">
          {t(`install.errors.${error}` as 'install.errors.required')}
        </p>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div>
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

const PHP = ['7.4', '8.1', '8.2', '8.3', '8.4'];

/** Wizard cài đặt lần đầu 10 bước (chỉ giao diện ở Phase 2; Phase 4 nối installer thật). */
export default function InstallPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const [s, setS] = useState<InstallState>(INITIAL);
  const [i, setI] = useState(0);
  const [errors, setErrors] = useState<Errors>({});
  const step = STEPS[i] as Step;
  const set = <K extends keyof InstallState>(k: K, v: InstallState[K]) => {
    setS((p) => ({ ...p, [k]: v }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([f]) => f !== k)));
  };
  const text = (k: keyof InstallState) => ({
    value: String(s[k]),
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as never),
  });
  const num = (k: keyof InstallState) => ({
    type: 'number' as const,
    value: String(s[k]),
    onChange: (e: { target: { value: string } }) => set(k, Number(e.target.value) as never),
  });

  const next = () => {
    const e = validate(step, s);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setI((x) => Math.min(STEPS.length - 1, x + 1));
  };
  const finish = () => {
    const bad = firstInvalid(s);
    if (bad) {
      setI(STEPS.indexOf(bad));
      setErrors(validate(bad, s));
      return;
    }
    toast.success(t('install.done'));
    void navigate({ to: '/login' });
  };

  const body: Record<Step, ReactNode> = {
    code: (
      <>
        <p className="text-base">{t('install.codeHint')}</p>
        <CodeBlock code="sudo itso setup-code" label={t('install.codeCommand')} />
        <Field label={t('install.setupCode')} error={errors.setupCode}>
          {(p) => (
            <Input
              {...p}
              {...text('setupCode')}
              autoComplete="off"
              placeholder="XXXX-XXXX-XXXX"
              className="font-mono uppercase"
            />
          )}
        </Field>
      </>
    ),
    language: (
      <>
        <Field label={t('install.locale')}>
          {(p) => (
            <Select
              id={p.id}
              value={s.locale}
              onValueChange={(v) => set('locale', v as 'vi' | 'en')}
              options={[
                { value: 'vi', label: 'Tiếng Việt' },
                { value: 'en', label: 'English' },
              ]}
            />
          )}
        </Field>
        <Field label={t('install.timezone')}>
          {(p) => (
            <Select
              id={p.id}
              value={s.timezone}
              onValueChange={(v) => set('timezone', v)}
              options={['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'UTC'].map((z) => ({
                value: z,
                label: z,
              }))}
            />
          )}
        </Field>
      </>
    ),
    admin: (
      <>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('install.adminName')} error={errors.adminName}>
            {(p) => <Input {...p} {...text('adminName')} autoComplete="name" />}
          </Field>
          <Field label={t('install.adminEmail')} error={errors.adminEmail}>
            {(p) => <Input {...p} {...text('adminEmail')} type="email" autoComplete="email" />}
          </Field>
        </div>
        <Field
          label={t('install.adminPassword')}
          error={errors.adminPassword}
          hint={t('install.passwordHint')}
        >
          {(p) => (
            <Input {...p} {...text('adminPassword')} type="password" autoComplete="new-password" />
          )}
        </Field>
        <Alert tone="info" title={t('install.mfaRequired')}>
          {t('install.mfaScan')}
        </Alert>
        <CodeBlock code="JBSWY3DPEHPK3PXP" label={t('install.mfaSecret')} />
        <Field label={t('install.mfaCode')} error={errors.mfaCode}>
          {(p) => (
            <Input
              {...p}
              value={s.mfaCode}
              onChange={(e) => set('mfaCode', e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="w-40 font-mono tracking-widest"
            />
          )}
        </Field>
      </>
    ),
    access: (
      <>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field
            label={t('install.panelDomain')}
            error={errors.panelDomain}
            hint={t('install.panelDomainHint')}
          >
            {(p) => <Input {...p} {...text('panelDomain')} placeholder="panel.example.vn" />}
          </Field>
          <Field label={t('install.panelPort')} error={errors.panelPort}>
            {(p) => <Input {...p} {...num('panelPort')} />}
          </Field>
        </div>
        <Field
          label={t('install.allowlist')}
          error={errors.allowlist}
          hint={t('install.allowlistHint')}
        >
          {(p) => (
            <Textarea
              {...p}
              {...text('allowlist')}
              rows={4}
              className="font-mono"
              placeholder={'10.10.5.0/24\n203.0.113.7'}
            />
          )}
        </Field>
      </>
    ),
    stack: (
      <>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-base font-medium">{t('install.php')}</legend>
          <div className="flex flex-wrap gap-4">
            {PHP.map((v) => (
              <label key={v} className="flex items-center gap-2 text-base">
                <Checkbox
                  checked={s.php.includes(v)}
                  onCheckedChange={(c) =>
                    set('php', c === true ? [...s.php, v].sort() : s.php.filter((x) => x !== v))
                  }
                />
                PHP {v}
              </label>
            ))}
          </div>
          {errors.php && (
            <p role="alert" className="text-xs text-danger-text">
              {t('install.errors.php')}
            </p>
          )}
        </fieldset>
        <Field label={t('install.database')}>
          {(p) => (
            <Select
              id={p.id}
              value={s.database}
              onValueChange={(v) => set('database', v as InstallState['database'])}
              options={[
                { value: 'postgresql', label: 'PostgreSQL 16' },
                { value: 'mysql', label: 'MariaDB 10.11' },
                { value: 'both', label: t('install.bothDb') },
              ]}
            />
          )}
        </Field>
        <Toggle
          label="Redis"
          hint={t('install.redisHint')}
          checked={s.redis}
          onChange={(v) => set('redis', v)}
        />
      </>
    ),
    security: (
      <>
        <Toggle
          label={t('install.firewall')}
          hint={t('install.firewallHint')}
          checked={s.firewall}
          onChange={(v) => set('firewall', v)}
        />
        <Toggle
          label="Fail2ban"
          hint={t('install.fail2banHint')}
          checked={s.fail2ban}
          onChange={(v) => set('fail2ban', v)}
        />
        <Field label={t('install.sshPort')} error={errors.sshPort}>
          {(p) => <Input {...p} {...num('sshPort')} className="w-32" />}
        </Field>
        <Toggle
          label={t('install.sshPassword')}
          hint={t('install.sshPasswordHint')}
          checked={s.sshPasswordAuth}
          onChange={(v) => set('sshPasswordAuth', v)}
        />
      </>
    ),
    quota: (
      <>
        <Toggle
          label={t('install.quota')}
          hint={t('install.quotaHint')}
          checked={s.quota}
          onChange={(v) => set('quota', v)}
        />
        <Alert tone="warning" title={t('install.quotaRebootTitle')}>
          {t('install.quotaReboot')}
        </Alert>
      </>
    ),
    backup: (
      <>
        <Field label={t('install.backupType')}>
          {(p) => (
            <Select
              id={p.id}
              value={s.backupType}
              onValueChange={(v) => set('backupType', v as InstallState['backupType'])}
              options={[
                { value: 'local', label: t('install.backupLocal') },
                { value: 's3', label: 'S3 / MinIO' },
                { value: 'sftp', label: 'SFTP' },
              ]}
            />
          )}
        </Field>
        <Field label={t('install.backupTarget')} error={errors.backupTarget}>
          {(p) => <Input {...p} {...text('backupTarget')} className="font-mono" />}
        </Field>
        <Field label={t('install.retention')} error={errors.retentionDays}>
          {(p) => <Input {...p} {...num('retentionDays')} className="w-32" />}
        </Field>
      </>
    ),
    smtp: (
      <>
        <Toggle
          label={t('install.smtpSkip')}
          hint={t('install.smtpSkipHint')}
          checked={s.smtpSkip}
          onChange={(v) => set('smtpSkip', v)}
        />
        {!s.smtpSkip && (
          <>
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <Field label={t('install.smtpHost')} error={errors.smtpHost}>
                {(p) => <Input {...p} {...text('smtpHost')} placeholder="smtp.example.vn" />}
              </Field>
              <Field label={t('install.smtpPort')} error={errors.smtpPort}>
                {(p) => <Input {...p} {...num('smtpPort')} />}
              </Field>
            </div>
            <Field label={t('install.smtpFrom')} error={errors.smtpFrom}>
              {(p) => (
                <Input {...p} {...text('smtpFrom')} type="email" placeholder="panel@example.vn" />
              )}
            </Field>
          </>
        )}
      </>
    ),
    summary: (
      <>
        <dl className="grid gap-x-6 gap-y-2 text-base sm:grid-cols-[auto_1fr]">
          {(
            [
              [t('install.steps.admin'), `${s.adminName} <${s.adminEmail}>`],
              [t('install.steps.access'), `https://${s.panelDomain}:${s.panelPort}`],
              [t('install.allowlist'), allowlistLines(s.allowlist).join(', ') || '—'],
              [
                t('install.steps.stack'),
                `PHP ${s.php.join(', ')} · ${s.database}${s.redis ? ' · Redis' : ''}`,
              ],
              [
                t('install.steps.security'),
                `${s.firewall ? 'UFW' : '—'} · ${s.fail2ban ? 'Fail2ban' : '—'} · SSH ${s.sshPort}`,
              ],
              [t('install.steps.quota'), s.quota ? t('install.on') : t('install.off')],
              [
                t('install.steps.backup'),
                `${s.backupType} · ${s.backupTarget} · ${t('install.days', { count: s.retentionDays })}`,
              ],
              [
                t('install.steps.smtp'),
                s.smtpSkip ? t('install.off') : `${s.smtpHost}:${s.smtpPort}`,
              ],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="wrap-anywhere">{v}</dd>
            </div>
          ))}
        </dl>
        {warnings(s).map((w) => (
          <Alert
            key={w}
            tone="warning"
            title={t(`install.warnings.${w}` as 'install.warnings.noSmtp')}
          />
        ))}
      </>
    ),
  };

  return (
    <AuthLayout
      title={t('install.title')}
      description={t('install.description')}
      area={t('auth.adminArea')}
      wide
    >
      <div className="grid gap-6 md:grid-cols-[13rem_1fr]">
        <nav aria-label={t('install.progress')}>
          <ProgressBar
            label={t('install.stepOf', { current: i + 1, total: STEPS.length })}
            value={i + 1}
            max={STEPS.length}
            className="mb-2 md:hidden"
          />
          <p className="mb-3 text-sm text-muted md:hidden">
            {t('install.stepOf', { current: i + 1, total: STEPS.length })}
          </p>
          <ol className="hidden flex-col gap-1 md:flex">
            {STEPS.map((st, k) => (
              <li key={st}>
                <button
                  type="button"
                  disabled={k > i}
                  onClick={() => setI(k)}
                  aria-current={k === i ? 'step' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-base disabled:cursor-default disabled:text-subtle',
                    k === i
                      ? 'bg-primary-soft font-medium text-primary-text'
                      : 'cursor-pointer hover:bg-surface-hover',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-6 shrink-0 place-items-center rounded-full border text-xs',
                      k < i ? 'border-success bg-success text-success-fg' : 'border-border-strong',
                    )}
                  >
                    {k < i ? <Check aria-hidden className="size-3.5" /> : k + 1}
                  </span>
                  {t(`install.steps.${st}`)}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <section aria-labelledby="step-title" className="flex min-w-0 flex-col gap-4">
          <h2 id="step-title" className="text-lg font-semibold">
            {t(`install.steps.${step}`)}
          </h2>
          {body[step]}
          <div className="mt-2 flex justify-between gap-2 border-t border-border pt-4">
            <Button
              variant="outline"
              onClick={() => setI((x) => Math.max(0, x - 1))}
              disabled={i === 0}
            >
              <ChevronLeft aria-hidden />
              {t('install.back')}
            </Button>
            {step === 'summary' ? (
              <Button onClick={finish}>
                <Rocket aria-hidden />
                {t('install.finish')}
              </Button>
            ) : (
              <Button onClick={next}>
                {t('install.next')}
                <ChevronRight aria-hidden />
              </Button>
            )}
          </div>
        </section>
      </div>
    </AuthLayout>
  );
}
