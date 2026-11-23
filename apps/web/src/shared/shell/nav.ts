import {
  Activity,
  Archive,
  Boxes,
  CalendarClock,
  Container,
  Database,
  FileClock,
  FolderOpen,
  Gauge,
  Globe,
  HardDriveDownload,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Lock,
  Network,
  Package,
  Server,
  Settings,
  ShieldCheck,
  SquareTerminal,
  UserCog,
  Users,
  Bell,
  GitBranch,
  Library,
  Blocks,
  BadgeCheck,
  Import,
  type LucideIcon,
} from 'lucide-react';

/** Khóa nhãn trong namespace shell: nav.<key>. */
export interface NavItem {
  key: string;
  href: string;
  icon: LucideIcon;
  badge?: number;
}

export interface NavGroup {
  key: 'overview' | 'infra' | 'hosting' | 'security' | 'admin' | 'account';
  items: NavItem[];
}

/** Theo docs/ui/sitemap.md mục A. `href` là đường dẫn đầy đủ (gồm basepath của entry). */
export const ADMIN_NAV: NavGroup[] = [
  {
    key: 'overview',
    items: [
      { key: 'dashboard', href: '/admin/dashboard', icon: LayoutDashboard },
      { key: 'jobs', href: '/admin/jobs', icon: ListChecks },
    ],
  },
  {
    key: 'infra',
    items: [
      { key: 'servers', href: '/admin/servers', icon: Server, badge: 3 },
      { key: 'docker', href: '/admin/compose-projects', icon: Container },
      { key: 'registries', href: '/admin/docker/registries', icon: Library },
    ],
  },
  {
    key: 'hosting',
    items: [
      { key: 'packages', href: '/admin/hosting-packages', icon: Package },
      { key: 'accounts', href: '/admin/hosting-accounts', icon: Boxes },
      { key: 'websites', href: '/admin/websites', icon: Globe },
      { key: 'databases', href: '/admin/databases', icon: Database },
      { key: 'files', href: '/admin/files', icon: FolderOpen },
      { key: 'sftp', href: '/admin/sftp', icon: KeyRound },
      { key: 'ssl', href: '/admin/ssl', icon: Lock },
      { key: 'dns', href: '/admin/dns', icon: Network },
      { key: 'cron', href: '/admin/cron', icon: CalendarClock },
      { key: 'wordpress', href: '/admin/wordpress', icon: Blocks },
      { key: 'gitDeployments', href: '/admin/git-deployments', icon: GitBranch },
      { key: 'imports', href: '/admin/imports', icon: Import },
    ],
  },
  {
    key: 'security',
    items: [
      { key: 'security', href: '/admin/security', icon: ShieldCheck },
      { key: 'backups', href: '/admin/backups', icon: Archive },
      { key: 'restores', href: '/admin/restores', icon: HardDriveDownload },
    ],
  },
  {
    key: 'admin',
    items: [
      { key: 'users', href: '/admin/users', icon: Users },
      { key: 'roles', href: '/admin/roles', icon: UserCog },
      { key: 'monitoring', href: '/admin/monitoring', icon: Activity },
      { key: 'audit', href: '/admin/audit-logs', icon: FileClock },
      { key: 'notifications', href: '/admin/notifications', icon: Bell },
      { key: 'settings', href: '/admin/settings', icon: Settings },
      { key: 'system', href: '/admin/system/readiness', icon: BadgeCheck },
    ],
  },
];

/** Theo sitemap mục B: chỉ chức năng của USER (không server, gói, user, firewall, Docker). */
export const PORTAL_NAV: NavGroup[] = [
  {
    key: 'overview',
    items: [
      { key: 'overview', href: '/portal/', icon: Gauge },
      { key: 'websites', href: '/portal/websites', icon: Globe },
      { key: 'databases', href: '/portal/databases', icon: Database },
      { key: 'files', href: '/portal/files', icon: FolderOpen },
      { key: 'sftp', href: '/portal/sftp', icon: KeyRound },
      { key: 'cron', href: '/portal/cron', icon: CalendarClock },
      { key: 'backups', href: '/portal/backups', icon: Archive },
      { key: 'wordpress', href: '/portal/wordpress', icon: Blocks },
      { key: 'terminal', href: '/portal/terminal', icon: SquareTerminal },
      { key: 'security', href: '/portal/security', icon: ShieldCheck },
      { key: 'monitoring', href: '/portal/monitoring', icon: Activity },
    ],
  },
  {
    key: 'account',
    items: [
      { key: 'notifications', href: '/portal/notifications', icon: Bell },
      { key: 'profile', href: '/portal/profile', icon: UserCog },
    ],
  },
];
