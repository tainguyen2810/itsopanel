import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';

/** Danh sách nhãn → giá trị (thông tin chi tiết), 2 cột, xuống dòng an toàn ở 390px. */
export function InfoList({
  items,
  className,
}: {
  items: [string, ReactNode][];
  className?: string;
}) {
  return (
    <dl className={cn('grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-base', className)}>
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 wrap-anywhere">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
