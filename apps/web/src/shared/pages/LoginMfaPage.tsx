import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/http';
import { AuthLayout } from '@/shared/page/AuthLayout';
import { useHomePath, useRoutesInfo } from '@/shared/routing/RoutesContext';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { sendAuth } from '@/shared/api/realm';

/** Bước 2 đăng nhập: mã TOTP 6 số hoặc mã khôi phục 10 ký tự. */
export default function LoginMfaPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const home = useHomePath();
  const { realm } = useRoutesInfo();
  const [method, setMethod] = useState<'totp' | 'recovery'>('totp');
  const [code, setCode] = useState('');
  const valid = method === 'totp' ? /^[0-9]{6}$/.test(code) : /^[a-z0-9]{10}$/.test(code);
  const verify = useMutation({
    mutationFn: () => sendAuth('POST', '/api/v1/auth/mfa/verify', { body: { code, method } }),
    onSuccess: () => void navigate({ to: home }),
  });
  return (
    <AuthLayout
      title={t('auth.mfaTitle')}
      description={method === 'totp' ? t('auth.mfaHint') : t('auth.recoveryHint')}
      area={realm === 'admin' ? t('auth.adminArea') : t('auth.portalArea')}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) verify.mutate();
        }}
      >
        {verify.isError && (
          <Alert tone="danger" title={t('auth.mfaFailed')}>
            {verify.error instanceof ApiError ? verify.error.problem.detail : String(verify.error)}
          </Alert>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="mfa">{method === 'totp' ? t('auth.code') : t('auth.recoveryCode')}</Label>
          <Input
            id="mfa"
            autoFocus
            autoComplete="one-time-code"
            inputMode={method === 'totp' ? 'numeric' : 'text'}
            maxLength={method === 'totp' ? 6 : 10}
            value={code}
            onChange={(e) =>
              setCode(
                method === 'totp'
                  ? e.target.value.replace(/\D/g, '')
                  : e.target.value.toLowerCase(),
              )
            }
            className="h-12 text-center font-mono text-xl tracking-[0.4em]"
          />
        </div>
        <Button type="submit" size="lg" disabled={!valid || verify.isPending}>
          {t('auth.verify')}
        </Button>
        <Button
          type="button"
          variant="link"
          onClick={() => {
            setMethod(method === 'totp' ? 'recovery' : 'totp');
            setCode('');
          }}
        >
          {method === 'totp' ? t('auth.useRecovery') : t('auth.useTotp')}
        </Button>
      </form>
    </AuthLayout>
  );
}
