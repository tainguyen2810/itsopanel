import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

interface Props {
  label: string;
  state: 'loading' | 'ok' | 'error';
  detail?: string | undefined;
}

/** Một dòng trạng thái: đang kiểm / OK / lỗi. */
export function StatusRow({ label, state, detail }: Props) {
  const Icon = state === 'loading' ? LoaderCircle : state === 'ok' ? CircleCheck : CircleX;
  return (
    <li className="flex items-center gap-3 py-2" data-testid={`status-${label}`} data-state={state}>
      <Icon
        aria-hidden
        className={cn(
          'size-5 shrink-0',
          state === 'loading' && 'animate-spin text-muted',
          state === 'ok' && 'text-ok',
          state === 'error' && 'text-bad',
        )}
      />
      <span className="font-medium">{label}</span>
      <span className="ml-auto text-sm text-muted">
        {state === 'loading' ? 'Đang kiểm tra…' : (detail ?? (state === 'ok' ? 'OK' : 'Lỗi'))}
      </span>
    </li>
  );
}
