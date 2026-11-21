import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorText } from '@/shared/api/useAction';
import { sendAuth } from '@/shared/api/realm';
import { FormDialog } from '@/shared/page/FormDialog';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { setStepUpHandler } from './stepUp';

/** Hộp thoại xác thực lại MFA (TOTP) khi API yêu cầu step-up; xem `stepUp.ts`. */
export function StepUpHost() {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setStepUpHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false);
          resolver.current = resolve;
          setCode('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => setStepUpHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
  };
  const submit = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError(t('stepUp.invalid'));
      return;
    }
    setPending(true);
    try {
      await sendAuth('POST', '/api/v1/auth/step-up', { body: { code, method: 'totp' } });
      finish(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => !o && finish(false)}
      title={t('stepUp.title')}
      description={t('stepUp.hint')}
      submitLabel={t('stepUp.confirm')}
      pending={pending}
      onSubmit={() => void submit()}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="step-up-code">{t('stepUp.code')}</Label>
        <Input
          id="step-up-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          aria-invalid={error !== null}
          aria-describedby={error ? 'step-up-error' : undefined}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, ''));
            setError(null);
          }}
          className="font-mono tracking-[0.3em]"
        />
        {error && (
          <p id="step-up-error" role="alert" className="text-xs text-danger-text">
            {error}
          </p>
        )}
      </div>
    </FormDialog>
  );
}
