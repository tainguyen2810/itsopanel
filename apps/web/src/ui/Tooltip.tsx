import type { ReactNode } from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

export const TooltipProvider = TooltipPrimitive.Provider;

/** Tooltip chỉ cho mô tả ngắn, không chứa thông tin bắt buộc (không truy cập được trên cảm ứng). */
export function Tooltip({
  content,
  children,
  side = 'top',
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-(--z-tooltip) max-w-64 rounded-md bg-fg px-2 py-1 text-xs text-bg shadow-md"
        >
          {content}
          <TooltipPrimitive.Arrow className="fill-fg" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
