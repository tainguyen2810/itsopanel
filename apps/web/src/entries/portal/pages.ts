import type { PageLoaders } from '@/shared/routing/createAppRouter';

/**
 * id route → trang (import động). Trang hosting dùng chung với Admin nằm ở `shared/hosting/pages`
 * và gọi API Portal (`configureRealmApi('portal', …)` trong App.tsx).
 */
export const PORTAL_PAGES: PageLoaders = {
  login: () => import('@/shared/pages/LoginPage'),
  loginMfa: () => import('@/shared/pages/LoginMfaPage'),
  forgotPassword: () => import('./pages/ForgotPasswordPage'),
  overview: () => import('./pages/OverviewPage'),
  accountDetail: () => import('./pages/AccountDetailPage'),
  websites: () => import('@/shared/hosting/pages/WebsitesPage'),
  websiteNew: () => import('./pages/WebsiteNewPage'),
  websiteDetail: () => import('@/shared/hosting/pages/WebsiteDetailPage'),
  databases: () => import('@/shared/hosting/pages/DatabasesPage'),
  files: () => import('@/shared/hosting/pages/FilesPage'),
  sftp: () => import('@/shared/hosting/pages/SftpPage'),
  cron: () => import('@/shared/hosting/pages/CronPage'),
  backups: () => import('./pages/BackupsPage'),
  wordpress: () => import('@/shared/hosting/pages/WordPressPage'),
  terminal: () => import('./pages/TerminalPage'),
  jobDetail: () => import('@/shared/pages/JobDetailPage'),
  notifications: () => import('@/shared/pages/NotificationsPage'),
  profile: () => import('@/shared/pages/ProfilePage'),
};
