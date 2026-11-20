import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';

interface Props {
  label: string;
  /** Khóa ổn định cho test (data-testid=status-<id>). */
  id: string;
  state: 'loading' | 'ok' | 'error';
  detail?: string | undefined;
}

/** Một dòng trạng thái: đang kiểm / OK / lỗi (luôn kèm chữ, không chỉ màu). */
export function StatusRow({ label, id, state, detail }: Props) {
  const { t } = useTranslation('status');
  const Icon = state === 'loading' ? LoaderCircle : state === 'ok' ? CircleCheck : CircleX;
  return (
    <li className="flex items-center gap-3 py-2" data-testid={`status-${id}`} data-state={state}>
      <Icon
        aria-hidden
        className={cn(
          'size-5 shrink-0',
          state === 'loading' && 'animate-spin text-muted',
          state === 'ok' && 'text-success-text',
          state === 'error' && 'text-danger-text',
        )}
      />
      <span className="font-medium">{label}</span>
      <span className="ml-auto text-right text-sm text-muted">
        {state === 'loading' ? t('checking') : (detail ?? (state === 'ok' ? 'OK' : '—'))}
      </span>
    </li>
  );
}
