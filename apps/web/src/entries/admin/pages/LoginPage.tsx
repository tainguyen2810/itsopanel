import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { LogIn } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { ApiError } from '@/api/http';
import { AuthLayout } from '@/shared/page/AuthLayout';
import { TextField } from '@/shared/page/fields';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { send } from '../api';

const schema = z.object({
  email: z.email('form.email'),
  password: z.string().min(1, 'form.required'),
});
type V = z.infer<typeof schema>;

/** Đăng nhập Admin (demo: không xác thực thật; tài khoản có MFA chuyển sang bước mã). */
export default function LoginPage() {
  const { t } = useTranslation('admin');
  const { user, demo } = useSession();
  const navigate = useNavigate();
  const { control, handleSubmit } = useForm<V>({
    resolver: zodResolver(schema),
    defaultValues: { email: demo ? user.email : '', password: demo ? 'demo-password' : '' },
  });
  const login = useMutation({
    mutationFn: (v: V) =>
      send<{ mfa_required: boolean }>('POST', '/api/v1/auth/login', { body: v }),
    onSuccess: (r) => void navigate({ to: r.mfa_required ? '/login/mfa' : '/dashboard' }),
  });
  return (
    <AuthLayout
      title={t('auth.loginTitle')}
      description={t('auth.loginHint')}
      area={t('auth.adminArea')}
    >
      <form
        noValidate
        onSubmit={handleSubmit((v) => login.mutate(v))}
        className="flex flex-col gap-4"
      >
        {login.isError && (
          <Alert tone="danger" title={t('auth.loginFailed')}>
            {login.error instanceof ApiError ? login.error.problem.detail : String(login.error)}
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
        <Button type="submit" size="lg" disabled={login.isPending}>
          <LogIn aria-hidden />
          {t('auth.signIn')}
        </Button>
        <Alert tone="info" title={t('auth.allowlistTitle')}>
          {t('auth.allowlist')}
        </Alert>
        {demo && <p className="text-center text-sm text-muted">{t('auth.demoNote')}</p>}
      </form>
    </AuthLayout>
  );
}
