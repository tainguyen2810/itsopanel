import type { ReactNode } from 'react';
import { Controller, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { Checkbox, Switch } from '@/ui/Checkbox';
import { FormField } from '@/ui/FormField';
import { Input, Textarea } from '@/ui/Input';
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
  disabled,
  ...base
}: Base<T> & {
  type?: 'text' | 'password' | 'email' | 'number' | 'url';
  autoComplete?: string;
  placeholder?: string;
  inputMode?: 'numeric' | 'text' | 'email';
  disabled?: boolean;
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
          {...(disabled ? { disabled: true } : {})}
          value={String(f.value ?? '')}
          onChange={(e) => f.onChange(type === 'number' ? e.target.valueAsNumber : e.target.value)}
        />
      )}
    />
  );
}

/** Ô nhập nhiều dòng nối react-hook-form. */
export function TextareaField<T extends FieldValues>({
  rows = 3,
  placeholder,
  ...base
}: Base<T> & { rows?: number; placeholder?: string }) {
  return (
    <FormField
      {...base}
      render={(f) => (
        <Textarea
          {...f}
          rows={rows}
          {...(placeholder ? { placeholder } : {})}
          className="font-mono"
          value={String(f.value ?? '')}
          onChange={(e) => f.onChange(e.target.value)}
        />
      )}
    />
  );
}

/** Select nối react-hook-form. */
export function SelectField<T extends FieldValues>({
  options,
  placeholder,
  onValueChange,
  disabled,
  ...base
}: Base<T> & {
  options: SelectOption[];
  placeholder?: string;
  /** Gọi thêm sau khi field đổi giá trị (vd điền mẫu). */
  onValueChange?: (v: string) => void;
  disabled?: boolean;
}) {
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
          {...(disabled ? { disabled: true } : {})}
          value={f.value === undefined || f.value === null ? undefined : String(f.value)}
          onValueChange={(v: string) => {
            f.onChange(v);
            onValueChange?.(v);
          }}
        />
      )}
    />
  );
}

/** Công tắc bật/tắt nối react-hook-form. */
export function SwitchField<T extends FieldValues>(base: Base<T>) {
  return (
    <FormField
      {...base}
      render={(f) => (
        <Switch
          id={f.id}
          checked={f.value === true}
          onCheckedChange={f.onChange}
          {...(f['aria-describedby'] ? { 'aria-describedby': f['aria-describedby'] } : {})}
        />
      )}
    />
  );
}

/** Nhóm ô đánh dấu chọn nhiều giá trị (mảng chuỗi) nối react-hook-form. */
export function CheckGroupField<T extends FieldValues>({
  options,
  ...base
}: Base<T> & { options: SelectOption[] }) {
  return (
    <FormField
      {...base}
      render={(f) => {
        const value = Array.isArray(f.value) ? (f.value as string[]) : [];
        return (
          <div
            id={f.id}
            role="group"
            aria-invalid={f['aria-invalid']}
            {...(f['aria-describedby'] ? { 'aria-describedby': f['aria-describedby'] } : {})}
            className="flex flex-col gap-2"
          >
            {options.map((o) => (
              <label key={o.value} className="flex items-center gap-2 text-base">
                <Checkbox
                  checked={value.includes(o.value)}
                  onCheckedChange={(c) =>
                    f.onChange(
                      c === true ? [...value, o.value] : value.filter((x) => x !== o.value),
                    )
                  }
                />
                {o.label}
              </label>
            ))}
          </div>
        );
      }}
    />
  );
}

/** Một ô đánh dấu (boolean) có nhãn bên cạnh. */
export function CheckboxField<T extends FieldValues>({
  control,
  name,
  label,
}: Pick<Base<T>, 'control' | 'name' | 'label'>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <label className="flex items-center gap-2 text-base">
          <Checkbox
            checked={field.value === true}
            onCheckedChange={(c) => field.onChange(c === true)}
          />
          {label}
        </label>
      )}
    />
  );
}
