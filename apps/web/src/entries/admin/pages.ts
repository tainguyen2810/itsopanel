import type { PageLoaders } from '@/shared/routing/createAppRouter';

/** id route → trang (import động). Route chưa có ở đây hiện trang tạm. */
export const ADMIN_PAGES: PageLoaders = {
  dashboard: () => import('./pages/DashboardPage'),
};
