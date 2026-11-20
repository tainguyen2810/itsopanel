import type { PageLoaders } from '@/shared/routing/createAppRouter';

/** id route → trang (import động). Route chưa có ở đây hiện trang tạm. */
export const ADMIN_PAGES: PageLoaders = {
  login: () => import('./pages/LoginPage'),
  loginMfa: () => import('./pages/LoginMfaPage'),
  install: () => import('./install/InstallPage'),
  dashboard: () => import('./pages/DashboardPage'),
  jobs: () => import('./pages/JobsPage'),
  jobDetail: () => import('./pages/JobDetailPage'),
  profile: () => import('./pages/ProfilePage'),
  search: () => import('./pages/SearchPage'),
};
