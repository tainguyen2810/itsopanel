import { useEffect, useId, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronLeft, ChevronRight, Rocket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/http';
import { errorText } from '@/shared/api/useAction';
import { sendAuth } from '@/shared/api/realm';
import { JobView } from '@/shared/jobs/JobDrawer';
import { cn } from '@/shared/lib/utils';
import { AuthLayout } from '@/shared/page/AuthLayout';
import { useHomePath } from '@/shared/routing/RoutesContext';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { CodeBlock } from '@/ui/CodeBlock';
import { Input, Textarea } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { ProgressBar } from '@/ui/ProgressBar';
import { Select } from '@/ui/Select';
import { get, list, send, type Data } from '../api';
import {
  accessBody,
  allowlistLines,
  INITIAL,
  LATER,
  resumeStep,
  STEPS,
  validate,
  warnings,
  type InstallState,
  type Step,
} from './wizard';

type Errors = Partial<Record<keyof InstallState, string>>;
type Status = Data<'/api/v1/admin/setup/status'>;
type Quota = Data<'/api/v1/admin/setup/quota'>;
type Stack = Data<'/api/v1/admin/setup/stack'>;
interface Enroll {
  secret: string;
  otpauth_uri: string;
  recovery_codes: string[];
}

/** Trường lỗi API (422 errors) → trường của state wizard. */
const FIELD: Record<string, keyof InstallState> = {
  code: 'setupCode',
  name: 'adminName',
  email: 'adminEmail',
  password: 'adminPassword',
  panel_domain: 'panelDomain',
  panel_port: 'panelPort',
  entrance_path: 'entrancePath',
  allowlist: 'allowlist',
};

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
          {error.startsWith('api:')
            ? error.slice(4)
            : t(`install.errors.${error}` as 'install.errors.required')}
        </p>
      )}
    </div>
  );
}

/** Wizard cài đặt lần đầu 10 bước, gọi /api/v1/admin/setup/* (Prompt 4.5). */
export default function InstallPage() {
  const { t } = useTranslation('admin');
  const status = useQuery({
    queryKey: ['setup', 'status'],
    queryFn: () => get('/api/v1/admin/setup/status'),
    retry: false,
  });
  if (status.isPending) {
    return (
      <AuthLayout title={t('install.title')} area={t('auth.adminArea')} wide>
        <p className="text-base text-muted">{t('install.loading')}</p>
      </AuthLayout>
    );
  }
  if (status.isError) {
    return (
      <AuthLayout title={t('install.title')} area={t('auth.adminArea')} wide>
        <Alert tone="danger" title={status.error.message} />
      </AuthLayout>
    );
  }
  if (status.data.installed) return <Installed />;
  return <Wizard initial={status.data} />;
}

function Installed() {
  const { t } = useTranslation('admin');
  return (
    <AuthLayout title={t('install.installedTitle')} area={t('auth.adminArea')}>
      <p className="text-base">{t('install.installedHint')}</p>
      <CodeBlock code="sudo itso admin reset-password <email>" label={t('install.resetCommand')} />
      <AppLink href="/login" className="font-medium text-primary-text hover:underline">
        {t('install.toLogin')}
      </AppLink>
    </AuthLayout>
  );
}

function Wizard({ initial }: { initial: Status }) {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const home = useHomePath();
  const qc = useQueryClient();
  const { refresh } = useSession();
  const [s, setS] = useState<InstallState>({
    ...INITIAL,
    locale: initial.locale,
    timezone: initial.timezone,
    adminCreated: initial.admin_created,
    ...(initial.access
      ? {
          panelDomain: initial.access.panel_domain ?? '',
          panelPort: initial.access.panel_port,
          entrancePath: initial.access.entrance_path ?? '',
          allowlist: initial.access.allowlist.join('\n'),
        }
      : {}),
  });
  const [i, setI] = useState(() => STEPS.indexOf(resumeStep(initial.steps_done)));
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [mfaDone, setMfaDone] = useState(initial.admin_mfa_enabled);
  const step = STEPS[i] as Step;
  const quota = useQuery({
    queryKey: ['setup', 'quota'],
    queryFn: () => get('/api/v1/admin/setup/quota'),
    enabled: step === 'quota' || step === 'summary',
    retry: false,
  });

  const set = <K extends keyof InstallState>(k: K, v: InstallState[K]) => {
    setS((p) => ({ ...p, [k]: v }));
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([f]) => f !== k)));
  };
  const text = (k: keyof InstallState) => ({
    value: String(s[k]),
    onChange: (e: { target: { value: string } }) => set(k, e.target.value as never),
  });

  /** Bước admin sau khi tạo SA: lấy secret TOTP để hiển thị. */
  useEffect(() => {
    if (step !== 'admin' || !s.adminCreated || mfaDone || enroll) return;
    sendAuth<Enroll>('POST', '/api/v1/auth/mfa/totp:enroll')
      .then(setEnroll)
      .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)));
  }, [step, s.adminCreated, mfaDone, enroll]);

  /** Lỗi API: 422 → lỗi theo trường; 410 → wizard đã khóa; còn lại → thông báo chung. */
  const onError = (e: unknown) => {
    if (!(e instanceof ApiError)) {
      setFailure(String(e));
      return;
    }
    const p = e.problem;
    if (p.status === 410) {
      void qc.invalidateQueries({ queryKey: ['setup', 'status'] });
      return;
    }
    const fieldErrors = (p as { errors?: Record<string, string[]> }).errors;
    if (p.status === 422 && fieldErrors) {
      const mapped: Errors = {};
      for (const [k, msgs] of Object.entries(fieldErrors)) {
        const f = FIELD[k.split('.')[0] ?? ''];
        if (f) mapped[f] = `api:${msgs[0] ?? p.title}`;
      }
      if (Object.keys(mapped).length > 0) {
        setErrors(mapped);
        return;
      }
    }
    setFailure(p.detail ?? p.title);
  };

  /** Gọi API của bước hiện tại; true = đi tiếp. */
  const submit = async (): Promise<boolean> => {
    switch (step) {
      case 'code':
        if (initial.steps_done.includes('code') && s.setupCode === '') return true;
        await send('POST', '/api/v1/admin/setup/code:verify', {
          body: { code: s.setupCode.trim().toUpperCase() },
        });
        return true;
      case 'language':
        await send('PUT', '/api/v1/admin/setup/preferences', {
          body: { locale: s.locale, timezone: s.timezone },
        });
        return true;
      case 'admin':
        if (mfaDone) return true;
        if (!s.adminCreated) {
          await send('POST', '/api/v1/admin/setup/admin', {
            body: {
              name: s.adminName.trim(),
              email: s.adminEmail.trim(),
              password: s.adminPassword,
            },
          });
          set('adminCreated', true);
          set('adminPassword', '');
          return false; // ở lại bước để bật TOTP
        }
        await sendAuth('POST', '/api/v1/auth/mfa/totp:confirm', {
          body: { code: s.mfaCode, method: 'totp' },
        });
        setMfaDone(true);
        return true;
      case 'access':
        await send('PUT', '/api/v1/admin/setup/access', { body: accessBody(s) });
        return true;
      default:
        return true;
    }
  };

  const next = async () => {
    setFailure(null);
    const e = step === 'admin' && mfaDone ? {} : validate(step, s);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setBusy(true);
    try {
      if (await submit()) setI((x) => Math.min(STEPS.length - 1, x + 1));
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setFailure(null);
    setBusy(true);
    try {
      await send('POST', '/api/v1/admin/setup:complete');
      toast.success(t('install.done'));
      await refresh();
      // Phase 7: hoàn tất wizard áp tường lửa mặc định bằng safe-apply (tự hoàn tác sau 5 phút nếu không xác nhận).
      // Chuyển tới trang Tường lửa của máy chủ để xác nhận ngay khi vẫn vào được panel.
      const servers = await list('/api/v1/admin/servers').catch(() => []);
      const local = servers[0];
      if (local) {
        toast.info(t('install.confirmFirewall'));
        void navigate({ to: '/servers/$id/firewall', params: { id: local.uuid } });
      } else {
        void navigate({ to: home });
      }
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
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
    admin: s.adminCreated ? (
      <>
        <Alert tone="success" title={t('install.adminCreated', { email: s.adminEmail || '—' })} />
        {mfaDone ? (
          <Alert tone="success" title={t('install.mfaRequired')} />
        ) : (
          <>
            <Alert tone="info" title={t('install.mfaRequired')}>
              {t('install.mfaScan')}
            </Alert>
            {enroll && (
              <>
                <CodeBlock code={enroll.secret} label={t('install.mfaSecret')} />
                <CodeBlock code={enroll.otpauth_uri} label={t('install.mfaUri')} />
                <Alert tone="warning" title={t('install.recoveryTitle')}>
                  {t('install.recoveryHint')}
                </Alert>
                <CodeBlock
                  code={enroll.recovery_codes.join('\n')}
                  label={t('install.recoveryTitle')}
                />
              </>
            )}
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
        )}
      </>
    ) : (
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
            {(p) => (
              <Input
                {...p}
                type="number"
                value={String(s.panelPort)}
                onChange={(e) => set('panelPort', Number(e.target.value))}
              />
            )}
          </Field>
        </div>
        <Field
          label={t('install.entrancePath')}
          error={errors.entrancePath}
          hint={t('install.entranceHint')}
        >
          {(p) => (
            <Input
              {...p}
              {...text('entrancePath')}
              placeholder="/itso-a7k2"
              className="font-mono"
            />
          )}
        </Field>
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
        <p className="text-sm text-muted">{t('install.accessApplyHint')}</p>
      </>
    ),
    stack: <StackStep />,
    security: <Later />,
    quota: <QuotaStep q={quota.data} error={quota.error} />,
    backup: <Later />,
    smtp: <Later />,
    summary: (
      <>
        <dl className="grid gap-x-6 gap-y-2 text-base sm:grid-cols-[auto_1fr]">
          {(
            [
              [t('install.steps.language'), `${s.locale} · ${s.timezone}`],
              [t('install.steps.admin'), s.adminEmail || '—'],
              [
                t('install.steps.access'),
                `https://${s.panelDomain || '<IP>'}:${s.panelPort}${s.entrancePath}`,
              ],
              [t('install.allowlist'), allowlistLines(s.allowlist).join(', ') || '—'],
              [
                t('install.steps.quota'),
                quota.data ? t(`install.quotaTitle.${quota.data.mode}`) : '—',
              ],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="wrap-anywhere">{v}</dd>
            </div>
          ))}
        </dl>
        {warnings(s, quota.data?.mode).map((w) => (
          <Alert
            key={w}
            tone="warning"
            title={t(`install.warnings.${w}` as 'install.warnings.noAllowlist')}
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
                  {LATER.includes(st) && (
                    <span className="sr-only">({t('install.laterTitle')})</span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <section aria-labelledby="step-title" className="flex min-w-0 flex-col gap-4">
          <h2 id="step-title" className="text-lg font-semibold">
            {t(`install.steps.${step}`)}
          </h2>
          {failure && <Alert tone="danger" title={failure} />}
          {body[step]}
          <div className="mt-2 flex justify-between gap-2 border-t border-border pt-4">
            <Button
              variant="outline"
              onClick={() => setI((x) => Math.max(0, x - 1))}
              disabled={i === 0 || busy}
            >
              <ChevronLeft aria-hidden />
              {t('install.back')}
            </Button>
            {step === 'summary' ? (
              <Button onClick={() => void finish()} disabled={busy}>
                <Rocket aria-hidden />
                {t('install.finish')}
              </Button>
            ) : (
              <Button onClick={() => void next()} disabled={busy}>
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

function Later() {
  const { t } = useTranslation('admin');
  return (
    <Alert tone="info" title={t('install.laterTitle')}>
      {t('install.laterHint')}
    </Alert>
  );
}

/**
 * Bước 4 (Prompt 5.5): trạng thái Nginx, PHP 8.3, lego trên server panel; cài phần còn thiếu qua job
 * (POST /admin/setup/stack:install) và theo dõi tiến độ ngay trong wizard. Bước không bắt buộc.
 */
function StackStep() {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const [failure, setFailure] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const stack = useQuery({
    queryKey: ['setup', 'stack'],
    queryFn: () => get('/api/v1/admin/setup/stack'),
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.components.some((c) => c.state === 'installing') ? 1000 : false,
  });
  const jobUuid = stack.data?.job_uuid ?? null;
  const job = useQuery({
    queryKey: ['setup', 'stack-job', jobUuid],
    queryFn: () => get('/api/v1/admin/jobs/{id}', { path: { id: jobUuid as string } }),
    enabled: jobUuid !== null,
    refetchInterval: (q) =>
      q.state.data && ['succeeded', 'failed', 'cancelled'].includes(q.state.data.state)
        ? false
        : 1000,
  });
  const jobState = job.data?.state;
  useEffect(() => {
    if (jobState === 'succeeded' || jobState === 'failed') void stack.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ làm mới khi job kết thúc
  }, [jobState]);

  const install = async () => {
    setFailure(null);
    setStarting(true);
    try {
      await send('POST', '/api/v1/admin/setup/stack:install');
      await stack.refetch();
    } catch (e) {
      setFailure(errorText(e, tc));
    } finally {
      setStarting(false);
    }
  };

  if (stack.isError) return <Alert tone="danger" title={errorText(stack.error, tc)} />;
  const d: Stack | undefined = stack.data;
  if (!d) return <p className="text-base text-muted">{t('install.loading')}</p>;
  const running = d.components.some((c) => c.state === 'installing');
  return (
    <>
      <Alert
        tone={d.ready ? 'success' : 'info'}
        title={t(d.ready ? 'install.stack.ready' : 'install.stack.missing')}
      >
        {t('install.stack.hint')}
      </Alert>
      {d.server && (
        <p className="text-sm text-muted">{t('install.quotaServer', { name: d.server.name })}</p>
      )}
      <ul
        aria-label={t('install.stack.components')}
        className="flex flex-col divide-y divide-border rounded-md border"
      >
        {d.components.map((c) => (
          <li key={c.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <span className="text-base">
              {c.name}
              {c.installed_version ? (
                <span className="ms-2 font-mono text-xs text-muted">{c.installed_version}</span>
              ) : null}
            </span>
            <StatusBadge status={c.state === 'installing' ? 'running' : c.state} />
          </li>
        ))}
      </ul>
      {failure && <Alert tone="danger" title={failure} />}
      {!d.ready && (
        <div>
          <Button onClick={() => void install()} disabled={starting || running}>
            {running ? t('install.stack.installing') : t('install.stack.install')}
          </Button>
        </div>
      )}
      {job.data && <JobView job={job.data} title={t('install.stack.job')} />}
      {!d.ready && <p className="text-sm text-muted">{t('install.stack.optional')}</p>}
    </>
  );
}

function QuotaStep({ q, error }: { q: Quota | undefined; error: Error | null }) {
  const { t } = useTranslation('admin');
  if (error) return <Alert tone="danger" title={error.message} />;
  if (!q) return <p className="text-base text-muted">{t('install.loading')}</p>;
  return (
    <>
      <Alert
        tone={q.mode === 'kernel' ? 'success' : 'warning'}
        title={t(`install.quotaTitle.${q.mode}`)}
      >
        {t(`install.quotaHint.${q.mode}`)}
      </Alert>
      {q.server && (
        <p className="text-sm text-muted">{t('install.quotaServer', { name: q.server.name })}</p>
      )}
    </>
  );
}
