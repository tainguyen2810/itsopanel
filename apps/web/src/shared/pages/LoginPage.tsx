import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ApiError } from '@/api/http';
import { AuthLayout } from '@/shared/page/AuthLayout';
import { useHomePath, useRoutesInfo } from '@/shared/routing/RoutesContext';
import { AppLink } from '@/ui/AppLink';
import { TextField } from '@/shared/page/fields';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { sendAuth } from '@/shared/api/realm';
import { Captcha, type CaptchaSolution } from '@/shared/auth/Captcha';

const schema = z.object({
  email: z.email('form.email'),
  password: z.string().min(1, 'form.required'),
});
type V = z.infer<typeof schema>;

/** Đăng nhập Admin/Portal (demo: không xác thực thật; tài khoản có MFA chuyển sang bước mã). */
export default function LoginPage() {
  const { t } = useTranslation('admin');
  const { user, demo, refresh } = useSession();
  const navigate = useNavigate();
  const home = useHomePath();
  const { realm, basepath } = useRoutesInfo();
  const admin = realm === 'admin';
  const { control, handleSubmit } = useForm<V>({
    resolver: zodResolver(schema),
    defaultValues: { email: demo ? user.email : '', password: demo ? 'demo-password' : '' },
  });
  // Sai quá ngưỡng → server trả 422 `captcha_required`; hiện CAPTCHA proof-of-work, gửi lời giải ở lần sau (D-81).
  const [captchaKey, setCaptchaKey] = useState(0);
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captcha, setCaptcha] = useState<CaptchaSolution | null>(null);
  const login = useMutation({
    mutationFn: (v: V) =>
      sendAuth<{ mfa_required: boolean; mfa_methods?: string[] }>('POST', '/api/v1/auth/login', {
        body: captcha ? { ...v, captcha } : v,
      }),
    onError: (e) => {
      // Lời giải chỉ dùng một lần: lần sai nào cũng cần thử thách mới.
      if (needCaptcha || (e instanceof ApiError && e.problem.code === 'captcha_required')) {
        setNeedCaptcha(true);
        setCaptchaKey((k) => k + 1);
      }
    },
    // Có phương thức MFA → bước mã; SUPER_ADMIN chưa bật MFA → shell đưa tới Hồ sơ để bật.
    onSuccess: async (r) => {
      await refresh();
      const needCode = r.mfa_required && (r.mfa_methods === undefined || r.mfa_methods.length > 0);
      void navigate({ to: needCode ? '/login/mfa' : home });
    },
  });
  return (
    <AuthLayout
      title={t('auth.loginTitle')}
      description={admin ? t('auth.loginHint') : t('auth.portalLoginHint')}
      area={admin ? t('auth.adminArea') : t('auth.portalArea')}
    >
      <form
        noValidate
        onSubmit={handleSubmit((v) => login.mutate(v))}
        className="flex flex-col gap-4"
      >
        {login.isError && (
          <Alert tone="danger" title={t('auth.loginFailed')}>
            {login.error instanceof ApiError
              ? login.error.problem.code === 'captcha_required'
                ? t('auth.captchaRequired')
                : (login.error.problem.errors?.email?.[0] ?? login.error.problem.detail)
              : String(login.error)}
          </Alert>
        )}
        <TextField
          control={control}
          name="email"
          type="email"
          autoComplete="username"
          label={t('auth.email')}
        />
        <TextField
          control={control}
          name="password"
          type="password"
          autoComplete="current-password"
          label={t('auth.password')}
        />
        {needCaptcha && <Captcha key={captchaKey} onSolved={setCaptcha} />}
        <Button type="submit" size="lg" disabled={login.isPending || (needCaptcha && !captcha)}>
          <LogIn aria-hidden />
          {t('auth.signIn')}
        </Button>
        {admin ? (
          <Alert tone="info" title={t('auth.allowlistTitle')}>
            {t('auth.allowlist')}
          </Alert>
        ) : (
          <AppLink
            href={`${basepath}/forgot-password`}
            className="inline-flex min-h-6 items-center justify-center self-center text-sm text-primary-text hover:underline"
          >
            {t('auth.forgot')}
          </AppLink>
        )}
        {demo && <p className="text-center text-sm text-muted">{t('auth.demoNote')}</p>}
      </form>
    </AuthLayout>
  );
}
