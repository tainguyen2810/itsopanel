import {
  Bell,
  Languages,
  LogOut,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
  Sun,
  UserRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useTheme, type Theme } from '@/shared/theme/ThemeProvider';
import { Button } from '@/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/DropdownMenu';
import { Avatar, Kbd } from '@/ui/Feedback';

export interface ShellUser {
  name: string;
  email: string;
  roleLabel: string;
}

interface Props {
  user: ShellUser;
  unread: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenMenu: () => void;
  onOpenSearch?: () => void;
}

const THEME_ICON = { light: Sun, dark: Moon, system: Monitor } as const;

export function Topbar({
  user,
  unread,
  collapsed,
  onToggleCollapse,
  onOpenMenu,
  onOpenSearch,
}: Props) {
  const { t, i18n } = useTranslation('shell');
  const { theme, setTheme } = useTheme();
  const ThemeIcon = THEME_ICON[theme];
  const lang = i18n.resolvedLanguage === 'en' ? 'en' : 'vi';

  return (
    <header className="sticky top-0 z-(--z-topbar) flex h-15 shrink-0 items-center gap-2 border-b border-border bg-bg/90 px-3 backdrop-blur sm:gap-3 sm:px-5">
      <Button
        variant="outline"
        size="icon"
        className="lg:hidden"
        aria-label={t('topbar.openMenu')}
        onClick={onOpenMenu}
      >
        <Menu aria-hidden />
      </Button>
      <span className="flex items-center gap-2 font-semibold lg:hidden" aria-hidden>
        <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-fg">
          <ShieldCheck className="size-4" />
        </span>
        <span className="hidden sm:inline">ITSO</span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="hidden lg:inline-flex"
        aria-label={collapsed ? t('topbar.expand') : t('topbar.collapse')}
        aria-pressed={collapsed}
        onClick={onToggleCollapse}
      >
        {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
      </Button>

      {onOpenSearch && (
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex h-9 min-w-0 flex-[0_1_28rem] cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-surface px-3 text-base text-muted hover:border-input focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Search aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{t('topbar.search')}</span>
          <Kbd className="ml-auto hidden sm:inline">{t('topbar.searchShortcut')}</Kbd>
        </button>
      )}

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('topbar.theme')}>
              <ThemeIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('topbar.theme')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <DropdownMenuRadioItem value="light">{t('topbar.themeLight')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">{t('topbar.themeDark')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                {t('topbar.themeSystem')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1.5 px-2">
              <Languages aria-hidden />
              <span className="sr-only">{t('topbar.language')}:</span>
              <span className="font-semibold uppercase">{lang}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('topbar.language')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={lang} onValueChange={(v) => void i18n.changeLanguage(v)}>
              <DropdownMenuRadioItem value="vi" lang="vi">
                Tiếng Việt
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="en" lang="en">
                English
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`${t('topbar.notifications')}: ${t('topbar.unread', { count: unread })}`}
        >
          <Bell aria-hidden />
          {unread > 0 && (
            <span
              aria-hidden
              className="absolute top-1 right-1 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[0.625rem] leading-4 font-semibold text-danger-fg"
            >
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md p-1 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-ring sm:pr-2',
              )}
            >
              <Avatar name={user.name} />
              <span className="sr-only md:hidden">{t('topbar.userMenu')}</span>
              <span className="hidden text-left leading-tight md:block">
                <span className="block text-sm font-medium">{user.name}</span>
                <span className="block text-xs text-muted">{user.roleLabel}</span>
              </span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>
              <span className="block text-sm text-fg">{user.name}</span>
              <span className="block font-normal">{user.email}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <UserRound aria-hidden />
              {t('topbar.profile')}
            </DropdownMenuItem>
            <DropdownMenuItem tone="danger">
              <LogOut aria-hidden />
              {t('topbar.signOut')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
