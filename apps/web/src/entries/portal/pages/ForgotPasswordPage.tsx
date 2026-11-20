import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { sendAuth } from '@/shared/api/realm';
import { errorText } from '@/shared/api/useAction';
import { AuthLayout } from '@/shared/page/AuthLayout';
import { TextField } from '@/shared/page/fields';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { Button } from '@/ui/Button';

const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'form.required')
    .email('form.email')
    .max(254, 'form.maxLength|254'),
});
type Form = z.infer<typeof schema>;

/** Quên mật khẩu: luôn báo "đã gửi nếu email tồn tại" để không lộ tài khoản (contract trả 204). */
export default function ForgotPasswordPage() {
  const { t } = useTranslation('admin');
  const [sent, setSent] = useState(false);
  const { control, handleSubmit } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });
  const m = useMutation({
    mutationFn: (v: Form) => sendAuth('POST', '/api/v1/auth/password:forgot', { body: v }),
    onSuccess: () => setSent(true),
  });
  return (
    <AuthLayout
      title={t('pt.forgotTitle')}
      description={t('pt.forgotHint')}
      area={t('auth.portalArea')}
    >
      {sent ? (
        <Alert tone="success" title={t('pt.forgotSent')}>
          {t('pt.forgotSentHint')}
        </Alert>
      ) : (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit((v) => m.mutate(v))();
          }}
        >
          {m.isError && <Alert tone="danger" title={errorText(m.error)} />}
          <TextField
            control={control}
            name="email"
            type="email"
            label={t('auth.email')}
            autoComplete="email"
          />
          <Button type="submit" disabled={m.isPending}>
            {t('pt.forgotSubmit')}
          </Button>
        </form>
      )}
      <AppLink href="/portal/login" className="text-sm text-primary hover:underline">
        {t('pt.backToLogin')}
      </AppLink>
    </AuthLayout>
  );
}
