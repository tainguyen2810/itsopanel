import { cn } from '@/shared/lib/utils';
import { AppLink } from '@/ui/AppLink';

export interface SectionItem {
  key: string;
  href: string;
  label: string;
}

/** Điều hướng phụ dạng tab-link dưới tiêu đề trang (cuộn ngang ở màn hẹp). */
export function SectionNav({
  label,
  items,
  current,
}: {
  label: string;
  items: SectionItem[];
  current: string;
}) {
  return (
    <nav aria-label={label} className="-mx-4 mb-1 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-1 border-b border-border">
        {items.map((s) => (
          <li key={s.key}>
            <AppLink
              href={s.href}
              aria-current={current === s.key ? 'page' : undefined}
              className={cn(
                'block rounded-md px-3 py-1.5 text-base whitespace-nowrap',
                current === s.key
                  ? 'bg-surface font-medium text-fg shadow-sm'
                  : 'text-muted hover:bg-surface-hover hover:text-fg',
              )}
            >
              {s.label}
            </AppLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
