import { useId, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from './Button';
import { Dialog, DialogContent } from './Dialog';
import { Input } from './Input';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Tên người dùng phải gõ lại đúng để bật nút xác nhận (thao tác nguy hiểm). */
  confirmName?: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  onConfirm: () => void | Promise<void>;
}

/** Hộp thoại xác nhận. Với `confirmName`, nút chỉ bật khi gõ đúng tên (phân biệt hoa thường, bỏ khoảng trắng 2 đầu). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmName,
  confirmLabel,
  tone = 'danger',
  onConfirm,
}: Props) {
  const { t } = useTranslation('common');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const matches = confirmName === undefined || typed.trim() === confirmName;

  const change = (o: boolean) => {
    if (!o) setTyped('');
    onOpenChange(o);
  };
  const submit = async () => {
    if (!matches || busy) return;
    setBusy(true);
    try {
      await onConfirm();
      change(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        role="alertdialog"
        title={title}
        description={description ?? t('confirm.irreversible')}
        footer={
          <>
            <Button variant="secondary" onClick={() => change(false)}>
              {t('actions.cancel')}
            </Button>
            <Button variant={tone} disabled={!matches || busy} onClick={() => void submit()}>
              {confirmLabel}
            </Button>
          </>
        }
      >
        {confirmName !== undefined && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label htmlFor={inputId} className="text-base">
              <Trans
                t={t}
                i18nKey="confirm.typeToConfirm"
                values={{ name: confirmName }}
                components={{ strong: <strong className="font-mono" /> }}
              />
            </label>
            <Input
              id={inputId}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              aria-invalid={typed !== '' && !matches}
            />
            {typed !== '' && !matches && (
              <p className="text-sm text-danger-text">{t('confirm.mismatch')}</p>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
