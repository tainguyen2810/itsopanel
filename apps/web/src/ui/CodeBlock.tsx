import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';

/** Khối lệnh/cấu hình chỉ đọc, có nút sao chép. Nội dung hiển thị dạng text (không render HTML). */
export function CodeBlock({
  code,
  label,
  className,
}: {
  code: string;
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard bị chặn: người dùng tự chọn chữ */
    }
  };
  return (
    <figure
      className={cn('overflow-hidden rounded-md border border-border bg-surface-2', className)}
    >
      {label !== undefined && (
        <figcaption className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted">
          {label}
        </figcaption>
      )}
      <div className="relative">
        <pre className="overflow-x-auto p-3 pr-12 font-mono text-sm leading-relaxed text-fg">
          <code>{code}</code>
        </pre>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copied ? t('actions.copied') : t('actions.copy')}
          className="absolute top-2 right-2 grid size-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
        >
          {copied ? (
            <Check aria-hidden className="size-4 text-success-text" />
          ) : (
            <Copy aria-hidden className="size-4" />
          )}
        </button>
      </div>
    </figure>
  );
}
