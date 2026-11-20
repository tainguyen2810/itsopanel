import type { ReactNode } from 'react';
import type { Control, FieldPath, FieldValues } from 'react-hook-form';
import { FormField } from '@/ui/FormField';
import { Input } from '@/ui/Input';
import { Select, type SelectOption } from '@/ui/Select';

interface Base<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  description?: ReactNode;
  optional?: boolean;
  className?: string;
}

/** Ô nhập chữ nối react-hook-form (nhãn, mô tả, lỗi i18n). */
export function TextField<T extends FieldValues>({
  type = 'text',
  autoComplete,
  placeholder,
  inputMode,
  ...base
}: Base<T> & {
  type?: 'text' | 'password' | 'email' | 'number' | 'url';
  autoComplete?: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'text' | 'email';
}) {
  return (
    <FormField
      {...base}
      render={(f) => (
        <Input
          {...f}
          type={type}
          {...(autoComplete ? { autoComplete } : {})}
          {...(placeholder ? { placeholder } : {})}
          {...(inputMode ? { inputMode } : {})}
          value={String(f.value ?? '')}
          onChange={(e) => f.onChange(type === 'number' ? e.target.valueAsNumber : e.target.value)}
        />
      )}
    />
  );
}

/** Select nối react-hook-form. */
export function SelectField<T extends FieldValues>({
  options,
  placeholder,
  ...base
}: Base<T> & { options: SelectOption[]; placeholder?: string }) {
  return (
    <FormField
      {...base}
      render={(f) => (
        <Select
          id={f.id}
          aria-invalid={f['aria-invalid']}
          {...(f['aria-describedby'] ? { 'aria-describedby': f['aria-describedby'] } : {})}
          options={options}
          {...(placeholder ? { placeholder } : {})}
          value={f.value === undefined || f.value === null ? undefined : String(f.value)}
          onValueChange={f.onChange}
        />
      )}
    />
  );
}
