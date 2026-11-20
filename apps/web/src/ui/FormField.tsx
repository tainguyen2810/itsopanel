import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { Label } from './Label';

interface Props<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  description?: ReactNode;
  optional?: boolean;
  /** Control nhận value/onChange (Input, Textarea, Select, Switch...). */
  render: (field: {
    id: string;
    value: unknown;
    onChange: (v: unknown) => void;
    onBlur: () => void;
    name: string;
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
  }) => ReactElement;
  className?: string;
}

/**
 * Trường biểu mẫu nối react-hook-form + schema zod: nhãn, mô tả, lỗi, aria-invalid/aria-describedby.
 * Thông báo lỗi trong schema là KEY i18n (vd. "form.required") để dịch được.
 */
export function FormField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  optional,
  render,
  className,
}: Props<T>) {
  const { t } = useTranslation('common');
  const id = useId();
  const descId = `${id}-desc`;
  const errId = `${id}-err`;
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => {
        const message = fieldState.error?.message;
        const describedBy =
          [description !== undefined ? descId : null, message ? errId : null]
            .filter(Boolean)
            .join(' ') || undefined;
        const el = render({
          id,
          value: field.value,
          onChange: field.onChange,
          onBlur: field.onBlur,
          name: field.name,
          'aria-invalid': message !== undefined,
          'aria-describedby': describedBy,
        });
        return (
          <div className={cn('flex flex-col gap-1.5', className)}>
            <Label htmlFor={id}>
              {label}
              {optional && (
                <span className="ml-1 font-normal text-muted">({t('form.optional')})</span>
              )}
            </Label>
            {isValidElement(el) ? cloneElement(el) : el}
            {description !== undefined && (
              <p id={descId} className="text-xs text-muted">
                {description}
              </p>
            )}
            {message !== undefined && (
              <p id={errId} role="alert" className="text-xs text-danger-text">
                {translateError(t as unknown as Translate, message)}
              </p>
            )}
          </div>
        );
      }}
    />
  );
}

type Translate = (k: string, o?: Record<string, unknown>) => string;

/**
 * "form.minLength|3" → t('form.minLength', {min: 3, max: 3}); một tham số số dùng được cho cả
 * {{min}} và {{max}}. Key không tồn tại thì hiện nguyên văn.
 */
function translateError(t: Translate, message: string): string {
  const [key = message, arg] = message.split('|');
  const opts = arg !== undefined ? { min: Number(arg), max: Number(arg) } : undefined;
  const out = t(key, opts);
  return out === key ? message : out;
}
