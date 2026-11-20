import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { readStorage, writeStorage } from '@/shared/lib/storage';
import { Drawer, DrawerContent } from '@/ui/Dialog';
import { CommandPalette } from './CommandPalette';
import { ADMIN_NAV, PORTAL_NAV, type NavGroup } from './nav';
import { Sidebar, SidebarNav, type StorageInfo } from './Sidebar';
import { Topbar, type DemoSwitch, type ShellUser } from './Topbar';

const COLLAPSE_KEY = 'itso.sidebar.collapsed';

interface ShellProps {
  activeKey: string;
  user: ShellUser;
  unread?: number;
  storage?: StorageInfo;
  demo?: DemoSwitch;
  onOpenNotifications?: () => void;
  onOpenProfile?: () => void;
  onSignOut?: () => void;
  /** Phần tử toàn cục thêm vào cuối shell (ví dụ drawer theo dõi job). */
  overlay?: ReactNode;
  children: ReactNode;
}

function Shell({
  groups,
  areaLabel,
  search,
  activeKey,
  user,
  unread = 0,
  storage,
  demo,
  onOpenNotifications,
  onOpenProfile,
  onSignOut,
  overlay,
  children,
}: ShellProps & { groups: NavGroup[]; areaLabel: string; search: boolean }) {
  const { t } = useTranslation('shell');
  const [collapsed, setCollapsed] = useState(() => readStorage(COLLAPSE_KEY) === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const toggle = () =>
    setCollapsed((c) => {
      writeStorage(COLLAPSE_KEY, c ? '0' : '1');
      return !c;
    });

  return (
    <div className="flex min-h-dvh bg-bg text-fg">
      <a
        href="#main"
        className="sr-only z-(--z-tooltip) rounded-md bg-primary px-3 py-2 text-primary-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t('skipToContent')}
      </a>
      <Sidebar
        groups={groups}
        activeKey={activeKey}
        collapsed={collapsed}
        areaLabel={areaLabel}
        {...(storage ? { storage } : {})}
      />

      <Drawer open={menuOpen} onOpenChange={setMenuOpen}>
        <DrawerContent side="left" title={`${t('brand')} · ${areaLabel}`} className="lg:hidden">
          <div className="flex h-full flex-col">
            <SidebarNav
              groups={groups}
              activeKey={activeKey}
              onNavigate={() => setMenuOpen(false)}
              {...(storage ? { storage } : {})}
            />
          </div>
        </DrawerContent>
      </Drawer>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          unread={unread}
          collapsed={collapsed}
          onToggleCollapse={toggle}
          onOpenMenu={() => setMenuOpen(true)}
          {...(search ? { onOpenSearch: () => setSearchOpen(true) } : {})}
          {...(demo ? { demo } : {})}
          {...(onOpenNotifications ? { onOpenNotifications } : {})}
          {...(onOpenProfile ? { onOpenProfile } : {})}
          {...(onSignOut ? { onSignOut } : {})}
        />
        <main
          id="main"
          tabIndex={-1}
          className="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-6 focus:outline-none sm:px-6"
        >
          {children}
        </main>
      </div>
      {overlay}
      {search && <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} groups={groups} />}
    </div>
  );
}

/** Shell của Private Admin Panel: sidebar đầy đủ theo mockup, topbar có Ctrl+K. */
export function AdminShell(props: ShellProps) {
  const { t } = useTranslation('shell');
  return <Shell {...props} groups={ADMIN_NAV} areaLabel={t('adminArea')} search />;
}

/** Shell của User Hosting Portal: gọn hơn, chỉ menu của USER, không tìm kiếm toàn hệ thống. */
export function PortalShell(props: ShellProps) {
  const { t } = useTranslation('shell');
  return <Shell {...props} groups={PORTAL_NAV} areaLabel={t('portalArea')} search={false} />;
}
