import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LogOut, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/http';
import { useFmt } from '@/shared/format/useFmt';
import { TextField } from '@/shared/page/fields';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { CodeBlock } from '@/ui/CodeBlock';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { Skeleton } from '@/ui/Feedback';
import { get, send } from '../api';

const pwSchema = z
  .object({
    current_password: z.string().min(1, 'form.required'),
    new_password: z.string().min(12, 'form.minLength|12'),
    confirm: z.string().min(1, 'form.required'),
  })
  .refine((v) => v.new_password === v.confirm, { path: ['confirm'], message: 'form.mismatch' });
type Pw = z.infer<typeof pwSchema>;

const errText = (e: unknown) =>
  e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e);

function PasswordCard() {
  const { t } = useTranslation('admin');
  const { control, handleSubmit, reset } = useForm<Pw>({
    resolver: zodResolver(pwSchema),
    defaultValues: { current_password: '', new_password: '', confirm: '' },
  });
  const m = useMutation({
    mutationFn: (v: Pw) =>
      send('POST', '/api/v1/auth/password:change', {
        body: { current_password: v.current_password, new_password: v.new_password },
      }),
    onSuccess: () => {
      toast.success(t('profile.passwordChanged'));
      reset();
    },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <Card>
      <CardHeader title={t('profile.password')} description={t('profile.passwordHint')} />
      <CardContent>
        <form
          noValidate
          onSubmit={handleSubmit((v) => m.mutate(v))}
          className="flex flex-col gap-3"
        >
          <TextField
            control={control}
            name="current_password"
            type="password"
            autoComplete="current-password"
            label={t('profile.currentPassword')}
          />
          <TextField
            control={control}
            name="new_password"
            type="password"
            autoComplete="new-password"
            label={t('profile.newPassword')}
          />
          <TextField
            control={control}
            name="confirm"
            type="password"
            autoComplete="new-password"
            label={t('profile.confirmPassword')}
          />
          <div>
            <Button type="submit" disabled={m.isPending}>
              <KeyRound aria-hidden />
              {t('profile.changePassword')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function MfaCard({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const enroll = useMutation({
    mutationFn: () =>
      send<{ secret: string; otpauth_uri: string; recovery_codes: string[] }>(
        'POST',
        '/api/v1/auth/mfa/totp:enroll',
      ),
    onError: (e) => toast.error(errText(e)),
  });
  const confirm = useMutation({
    mutationFn: () =>
      send('POST', '/api/v1/auth/mfa/totp:confirm', { body: { code, method: 'totp' } }),
    onSuccess: () => {
      toast.success(t('profile.mfaEnabled'));
      enroll.reset();
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <Card>
      <CardHeader
        title={t('profile.mfa')}
        description={t('profile.mfaHint')}
        action={<StatusBadge status={enabled ? 'active' : 'disabled'} />}
      />
      <CardContent className="flex flex-col gap-3">
        {enabled && !enroll.data && (
          <Alert tone="success" title={t('profile.mfaOn')}>
            {t('profile.mfaOnHint')}
          </Alert>
        )}
        {!enroll.data ? (
          <div>
            <Button
              variant={enabled ? 'outline' : 'primary'}
              onClick={() => enroll.mutate()}
              disabled={enroll.isPending}
            >
              <ShieldCheck aria-hidden />
              {enabled ? t('profile.mfaReset') : t('profile.mfaSetup')}
            </Button>
          </div>
        ) : (
          <>
            <p className="text-base">{t('profile.mfaScan')}</p>
            <CodeBlock code={enroll.data.secret} label={t('profile.mfaSecret')} />
            <p className="text-sm text-muted">{t('profile.recoveryHint')}</p>
            <CodeBlock
              code={enroll.data.recovery_codes.join('\n')}
              label={t('profile.recoveryCodes')}
            />
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                confirm.mutate();
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mfa-code">{t('profile.mfaCode')}</Label>
                <Input
                  id="mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  className="w-40 font-mono tracking-widest"
                />
              </div>
              <Button type="submit" disabled={code.length !== 6 || confirm.isPending}>
                {t('profile.mfaConfirm')}
              </Button>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SessionsCard() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'sessions'],
    queryFn: () => get('/api/v1/auth/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => send('DELETE', '/api/v1/auth/sessions/{id}', { path: { id } }),
    onSuccess: () => {
      toast.success(t('profile.sessionRevoked'));
      void q.refetch();
    },
    onError: (e) => toast.error(errText(e)),
  });
  return (
    <Card className="lg:col-span-2">
      <CardHeader title={t('profile.sessions')} description={t('profile.sessionsHint')} />
      <CardContent>
        {q.isPending ? (
          <Skeleton className="h-24" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {q.data.map((s) => (
              <li key={s.uuid} className="flex flex-wrap items-center gap-3 py-3">
                <MonitorSmartphone aria-hidden className="size-5 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {s.user_agent}{' '}
                    {s.current && <Badge tone="success">{t('profile.thisDevice')}</Badge>}
                  </p>
                  <p className="text-sm text-muted">
                    {s.ip} · {t('profile.lastActive', { time: fmt.rel(s.last_active_at) })}
                  </p>
                </div>
                {!s.current && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => revoke.mutate(s.uuid)}
                    disabled={revoke.isPending}
                  >
                    <LogOut aria-hidden />
                    {t('profile.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Hồ sơ: thông tin, đổi mật khẩu, MFA (TOTP + mã khôi phục), phiên đăng nhập. */
export default function ProfilePage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const me = useQuery({ queryKey: ['me'], queryFn: () => get('/api/v1/auth/me') });
  const u = me.data?.user;
  return (
    <>
      <PageHeader title={t('profile.title')} description={t('profile.description')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader title={t('profile.info')} />
          <CardContent>
            {me.isPending ? (
              <Skeleton className="h-20" />
            ) : me.isError ? (
              <ErrorState error={me.error} onRetry={() => void me.refetch()} />
            ) : u ? (
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                {(
                  [
                    [t('profile.name'), u.name],
                    [t('profile.email'), u.email],
                    [t('profile.role'), t(`roles.${u.role}`)],
                    [t('profile.locale'), u.locale.toUpperCase()],
                    [t('profile.timezone'), u.timezone],
                    [t('profile.lastLogin'), fmt.opt(u.last_login_at)],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-sm text-muted">{k}</dt>
                    <dd className="font-medium wrap-anywhere">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </CardContent>
        </Card>
        <PasswordCard />
        <MfaCard enabled={u?.mfa_enabled ?? false} />
        <SessionsCard />
      </div>
    </>
  );
}
