import { useEffect } from 'react';
import { Command } from 'cmdk';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NavGroup } from './nav';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: NavGroup[];
}

/** Ctrl+K / ⌘K: tìm nhanh trang. Phase 2 bổ sung server, account, website, user từ API tìm kiếm. */
export function CommandPalette({ open, onOpenChange, groups }: Props) {
  const { t } = useTranslation('shell');
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

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-(--z-overlay) bg-overlay" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-(--z-modal) w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border-strong bg-surface text-fg shadow-lg"
        >
          <DialogPrimitive.Title className="sr-only">{t('command.title')}</DialogPrimitive.Title>
          <Command label={t('command.title')}>
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search aria-hidden className="size-4 text-muted" />
              <Command.Input
                placeholder={t('command.placeholder')}
                className="h-11 flex-1 bg-transparent text-base outline-none placeholder:text-subtle"
              />
            </div>
            <Command.List className="max-h-80 overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-base text-muted">
                {t('command.empty')}
              </Command.Empty>
              <Command.Group
                heading={t('command.pages')}
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted"
              >
                {groups.flatMap((g) =>
                  g.items.map((it) => {
                    const label = t(`nav.${it.key}` as 'nav.dashboard');
                    return (
                      <Command.Item
                        key={it.key}
                        value={`${label} ${it.key}`}
                        onSelect={() => {
                          onOpenChange(false);
                          window.location.assign(it.href);
                        }}
                        className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-base data-[selected=true]:bg-surface-hover"
                      >
                        <it.icon aria-hidden className="size-4 text-muted" />
                        {label}
                      </Command.Item>
                    );
                  }),
                )}
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
