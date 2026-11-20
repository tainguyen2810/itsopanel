import type { ReactNode } from 'react';
import { useBreadcrumbs } from '@/shared/routing/useBreadcrumbs';
import { Breadcrumb } from '@/ui/Navigation';

interface Props {
  title: ReactNode;
  /** Nhãn crumb cuối (mặc định lấy tiêu đề nếu là chuỗi). */
  crumb?: string;
  description?: ReactNode;
  /** Badge/trạng thái cạnh tiêu đề. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** Điều hướng phụ dưới tiêu đề (vd. các mục của một server). */
  nav?: ReactNode;
}

/** Đầu trang: breadcrumb tự sinh, tiêu đề h1, mô tả, hành động. */
export function PageHeader({ title, crumb, description, meta, actions, nav }: Props) {
  const crumbs = useBreadcrumbs(crumb ?? (typeof title === 'string' ? title : undefined));
  return (
    <header className="mb-5 flex flex-col gap-3">
      {crumbs.length > 1 && <Breadcrumb items={crumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold wrap-anywhere">{title}</h1>
            {meta}
          </div>
          {description !== undefined && (
            <p className="mt-1 max-w-3xl text-base text-muted">{description}</p>
          )}
        </div>
        {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {nav}
    </header>
  );
}
