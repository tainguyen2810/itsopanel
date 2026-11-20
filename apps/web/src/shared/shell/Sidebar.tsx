import { HardDrive, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useAppLink } from '@/ui/AppLink';
import { ProgressBar } from '@/ui/ProgressBar';
import type { NavGroup } from './nav';

export interface StorageInfo {
  used: string;
  total: string;
  ratio: number;
}

interface Props {
  groups: NavGroup[];
  activeKey: string;
  collapsed?: boolean;
  areaLabel: string;
  storage?: StorageInfo;
  onNavigate?: () => void;
}

export function Brand({ collapsed, areaLabel }: { collapsed?: boolean; areaLabel: string }) {
  const { t } = useTranslation('shell');
  return (
    <div
      className={cn(
        'flex h-15 shrink-0 items-center gap-2.5 border-b border-border px-5',
        collapsed && 'justify-center px-0',
      )}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-fg">
        <ShieldCheck aria-hidden className="size-5" />
      </span>
      {!collapsed && (
        <span className="min-w-0 leading-tight">
          <span className="block font-semibold">{t('brand')}</span>
          <span className="block truncate text-xs text-muted">{areaLabel}</span>
        </span>
      )}
    </div>
  );
}

/** Nội dung sidebar (dùng cho cả sidebar cố định và drawer mobile). */
export function SidebarNav({
  groups,
  activeKey,
  collapsed = false,
  storage,
  onNavigate,
}: Omit<Props, 'areaLabel'>) {
  const { t } = useTranslation('shell');
  const Link = useAppLink();
  return (
    <>
      <nav aria-label={t('nav.label')} className="flex-1 overflow-y-auto px-2 py-3">
        {groups.map((g) => (
          <div key={g.key} className="mb-3">
            {!collapsed && (
              <p className="px-3 pb-1 text-xs font-medium tracking-wide text-subtle uppercase">
                {t(`nav.groups.${g.key}`)}
              </p>
            )}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((it) => {
                const active = it.key === activeKey;
                const label = t(`nav.${it.key}` as 'nav.dashboard');
                return (
                  <li key={it.key}>
                    <Link
                      href={it.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? label : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-3 py-2 text-base text-fg/85 hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
                        active &&
                          'bg-primary-soft font-medium text-primary-text hover:bg-primary-soft hover:text-primary-text',
                        collapsed && 'justify-center px-0',
                      )}
                    >
                      <it.icon aria-hidden className="size-4.5 shrink-0" />
                      {collapsed ? (
                        <span className="sr-only">{label}</span>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate">{label}</span>
                          {it.badge !== undefined && (
                            <span className="rounded-full border border-border-strong bg-surface-2 px-2 text-xs text-muted tabular-nums">
                              {it.badge}
                            </span>
                          )}
                        </>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      {storage && !collapsed && (
        <div className="m-3 rounded-lg border border-border bg-surface p-3">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            <HardDrive aria-hidden className="size-4 text-muted" />
            {t('storage.title')}
          </p>
          <ProgressBar
            label={t('storage.title')}
            value={storage.ratio * 100}
            thresholds={{ warn: 75, danger: 90 }}
          />
          <p className="mt-1.5 text-xs text-muted tabular-nums">
            {t('storage.used', { used: storage.used, total: storage.total })}
          </p>
        </div>
      )}
    </>
  );
}

export function Sidebar(props: Props) {
  return (
    <aside
      className={cn(
        'sticky top-0 z-(--z-sidebar) hidden h-dvh shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 lg:flex',
        props.collapsed ? 'w-18' : 'w-64',
      )}
    >
      <Brand
        areaLabel={props.areaLabel}
        {...(props.collapsed !== undefined ? { collapsed: props.collapsed } : {})}
      />
      <SidebarNav {...props} />
    </aside>
  );
}
