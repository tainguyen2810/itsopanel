import type { ComponentProps, ReactNode } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

function Overlay() {
  return (
    <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-overlay) bg-overlay data-[state=open]:animate-in" />
  );
}

interface ContentProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
}

/** Hộp thoại giữa màn hình. Có tiêu đề + mô tả cho screen reader, Esc/nút X để đóng, khóa focus. */
export function DialogContent({
  title,
  description,
  footer,
  className,
  children,
  ...props
}: ContentProps) {
  const { t } = useTranslation('common');
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-(--z-modal) flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border-strong bg-surface text-fg shadow-lg focus:outline-none',
          className,
        )}
        {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        {...props}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
            {description !== undefined && (
              <DialogPrimitive.Description className="mt-1 text-base text-muted">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-muted hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t('actions.close')}
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer !== undefined && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

interface DrawerProps extends Omit<ComponentProps<typeof DialogPrimitive.Content>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  side?: 'left' | 'right';
}

/** Ngăn kéo trượt từ cạnh màn hình (cũng dùng cho sidebar ở mobile). */
export function DrawerContent({
  title,
  description,
  side = 'right',
  className,
  children,
  ...props
}: DrawerProps) {
  const { t } = useTranslation('common');
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-y-0 z-(--z-drawer) flex w-[min(22rem,calc(100vw-3rem))] flex-col border-border-strong bg-surface text-fg shadow-lg focus:outline-none',
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
          className,
        )}
        {...(description === undefined ? { 'aria-describedby': undefined } : {})}
        {...props}
      >
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
          <DialogPrimitive.Title className="text-md font-semibold">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close
            className="grid size-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={t('actions.close')}
          >
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        </div>
        {description !== undefined && (
          <DialogPrimitive.Description className="px-5 pt-3 text-base text-muted">
            {description}
          </DialogPrimitive.Description>
        )}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
