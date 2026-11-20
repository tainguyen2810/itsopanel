import type { ComponentProps } from 'react';
import { DropdownMenu as Menu } from 'radix-ui';
import { Check } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        className={cn(
          'z-(--z-popover) min-w-44 rounded-md border border-border-strong bg-surface p-1 text-fg shadow-lg',
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

const item =
  'relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-base outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-hover [&_svg]:size-4 [&_svg]:text-muted';

export function DropdownMenuItem({
  className,
  tone,
  ...props
}: ComponentProps<typeof Menu.Item> & { tone?: 'danger' }) {
  return (
    <Menu.Item
      className={cn(item, tone === 'danger' && 'text-danger-text', className)}
      {...props}
    />
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(item, 'pl-7', className)} {...props}>
      <Menu.ItemIndicator className="absolute left-2">
        <Check aria-hidden />
      </Menu.ItemIndicator>
      {children}
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn('px-2 py-1.5 text-xs font-medium text-muted', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('my-1 h-px bg-border', className)} {...props} />;
}
