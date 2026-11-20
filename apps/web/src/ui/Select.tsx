import type { ComponentProps } from 'react';
import { Select as SelectPrimitive } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props extends Omit<ComponentProps<typeof SelectPrimitive.Root>, 'children'> {
  options: SelectOption[];
  placeholder?: string;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

/** Select dựa trên Radix (bàn phím, screen reader đầy đủ). */
export function Select({ options, placeholder, id, className, ...rest }: Props) {
  const {
    'aria-label': ariaLabel,
    'aria-invalid': ariaInvalid,
    'aria-describedby': describedBy,
    ...root
  } = rest;
  return (
    <SelectPrimitive.Root {...root}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-describedby={describedBy}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-surface px-3 text-base text-fg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50 aria-invalid:border-danger data-[placeholder]:text-subtle',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown aria-hidden className="size-4 text-muted" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-(--z-popover) max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden rounded-md border border-border-strong bg-surface text-fg shadow-lg"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                {...(o.disabled ? { disabled: true } : {})}
                className="relative flex cursor-pointer items-center rounded-sm py-1.5 pr-2 pl-7 text-base outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-hover"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-2">
                  <Check aria-hidden className="size-4" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
