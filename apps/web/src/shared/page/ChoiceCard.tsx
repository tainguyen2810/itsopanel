import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';

/** Ô chọn dạng thẻ (radio) dùng trong wizard. */
export function ChoiceCard({
  name,
  value,
  checked,
  disabled,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-md border p-3 text-base',
        checked ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-hover',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="mt-1 accent-[var(--itso-primary)]"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}
