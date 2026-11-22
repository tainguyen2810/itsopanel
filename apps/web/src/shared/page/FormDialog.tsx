import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/Button';
import { Dialog, DialogContent } from '@/ui/Dialog';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  submitLabel?: string;
  pending?: boolean;
  /** Khóa nút gửi khi điều kiện ngoài form chưa đạt (vd chưa kiểm compose.yaml). */
  submitDisabled?: boolean;
  className?: string;
  onSubmit: () => void;
  children: ReactNode;
}

/** Form trong Dialog: nút Hủy / Lưu ở chân, Enter để gửi, khóa nút khi đang gửi. */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  pending = false,
  submitDisabled = false,
  className,
  onSubmit,
  children,
}: Props) {
  const { t } = useTranslation('common');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        {...(description ? { description } : {})}
        {...(className ? { className } : {})}
      >
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {children}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={pending || submitDisabled}>
              {submitLabel ?? t('actions.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
