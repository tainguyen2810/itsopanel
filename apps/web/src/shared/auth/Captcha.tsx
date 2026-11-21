import { useEffect, useState } from 'react';
import { CircleCheck, Loader2, ShieldQuestion } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAuth } from '@/shared/api/realm';
import { solveCaptcha } from './captcha';

export interface CaptchaSolution {
  challenge: string;
  nonce: string;
}

/**
 * CAPTCHA proof-of-work (D-81): lấy thử thách từ `/api/v1/auth/captcha`, giải trong Web Worker rồi trả lời giải.
 * Không gọi dịch vụ ngoài, không cần người dùng bấm gì; `key` mới → lấy thử thách mới.
 */
export function Captcha({ onSolved }: { onSolved: (s: CaptchaSolution | null) => void }) {
  const { t } = useTranslation('common');
  const [state, setState] = useState<'loading' | 'solving' | 'solved' | 'error'>('loading');
  useEffect(() => {
    let cancel = () => {};
    let alive = true;
    onSolved(null);
    getAuth('/api/v1/auth/captcha')
      .then((c) => {
        if (!alive) return;
        setState('solving');
        const job = solveCaptcha(c.challenge, c.difficulty);
        cancel = job.cancel;
        return job.promise.then((nonce) => {
          if (!alive) return;
          setState('solved');
          onSolved({ challenge: c.challenge, nonce });
        });
      })
      .catch(() => alive && setState('error'));
    return () => {
      alive = false;
      cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const Icon = state === 'solved' ? CircleCheck : state === 'error' ? ShieldQuestion : Loader2;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="captcha"
      data-state={state}
      className="flex items-center gap-3 rounded-md border border-border bg-surface-2 px-3 py-2.5 text-sm"
    >
      <Icon
        aria-hidden
        className={
          state === 'solved'
            ? 'size-5 text-success-text'
            : state === 'error'
              ? 'size-5 text-danger-text'
              : 'size-5 animate-spin text-muted'
        }
      />
      <div className="min-w-0">
        <p className="font-medium text-fg">{t(`captcha.${state}`)}</p>
        <p className="text-muted">{t('captcha.hint')}</p>
      </div>
    </div>
  );
}
