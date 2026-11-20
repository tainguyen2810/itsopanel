import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { LoaderCircle, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NavGroup } from './nav';

export interface SearchHit {
  id: string;
  label: string;
  /** Dòng phụ (IP, server, email…). */
  sub?: string;
  href: string;
}
export interface SearchGroup {
  key: string;
  label: string;
  hits: SearchHit[];
}
export type SearchFn = (q: string) => Promise<SearchGroup[]>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: NavGroup[];
  /** Tìm dữ liệu thật (server, account, website, user) qua API danh sách với `q`. */
  search?: SearchFn;
  /** Điều hướng trong app (router); mặc định tải trang. */
  onNavigate?: (href: string) => void;
}

/** Bỏ dấu tiếng Việt để tìm "may chu" ra "Máy chủ". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** Ctrl+K / ⌘K: tìm nhanh trang và dữ liệu (server, account, website, user). */
export function CommandPalette({ open, onOpenChange, groups, search, onNavigate }: Props) {
  const { t } = useTranslation('shell');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => (search ? search(debounced) : Promise.resolve([])),
    enabled: open && search !== undefined && debounced.length >= 2,
    staleTime: 10_000,
  });

  const go = (href: string) => {
    onOpenChange(false);
    setQ('');
    if (onNavigate) onNavigate(href);
    else window.location.assign(href);
  };
  const needle = fold(q.trim());
  const pages = groups.flatMap((g) =>
    g.items
      .map((it) => ({ ...it, label: t(`nav.${it.key}` as 'nav.dashboard') }))
      .filter((it) => needle === '' || fold(`${it.label} ${it.key}`).includes(needle)),
  );
  const hits = debounced.length >= 2 ? (results.data ?? []).filter((g) => g.hits.length > 0) : [];
  const itemCls =
    'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-base data-[selected=true]:bg-surface-hover';
  const groupCls =
    '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted';

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-overlay) bg-overlay" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-(--z-modal) w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border-strong bg-surface text-fg shadow-lg"
        >
          <DialogPrimitive.Title className="sr-only">{t('command.title')}</DialogPrimitive.Title>
          <Command label={t('command.title')} shouldFilter={false}>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search aria-hidden className="size-4 text-muted" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder={t('command.placeholder')}
                className="h-11 flex-1 bg-transparent text-base outline-none placeholder:text-subtle"
              />
              {results.isFetching && (
                <LoaderCircle aria-hidden className="size-4 animate-spin text-muted" />
              )}
            </div>
            <Command.List className="max-h-96 overflow-y-auto p-1">
              {pages.length === 0 && hits.length === 0 && !results.isFetching && (
                <p className="px-3 py-6 text-center text-base text-muted">{t('command.empty')}</p>
              )}
              {hits.map((g) => (
                <Command.Group key={g.key} heading={g.label} className={groupCls}>
                  {g.hits.map((h) => (
                    <Command.Item
                      key={`${g.key}-${h.id}`}
                      value={`${g.key}-${h.id}`}
                      onSelect={() => go(h.href)}
                      className={itemCls}
                    >
                      <span className="min-w-0 flex-1 truncate">{h.label}</span>
                      {h.sub && <span className="truncate text-sm text-muted">{h.sub}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
              {pages.length > 0 && (
                <Command.Group heading={t('command.pages')} className={groupCls}>
                  {pages.map((it) => (
                    <Command.Item
                      key={it.key}
                      value={`page-${it.key}`}
                      onSelect={() => go(it.href)}
                      className={itemCls}
                    >
                      <it.icon aria-hidden className="size-4 text-muted" />
                      {it.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
