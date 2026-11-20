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
  servers: () => import('./servers/ServersPage'),
  serverNew: () => import('./servers/ServerNewPage'),
  serverDetail: () => import('./servers/ServerDetailPage'),
  serverNginx: () => import('./servers/ServerNginxPage'),
  serverPhp: () => import('./servers/ServerPhpPage'),
  serverSoftware: () => import('./servers/ServerSoftwarePage'),
  serverFirewall: () => import('./servers/ServerFirewallPage'),
  serverDocker: () => import('./servers/ServerDockerPage'),
  serverTerminal: () => import('./servers/ServerTerminalPage'),
  compose: () => import('./docker/ComposePage'),
  composeDetail: () => import('./docker/ComposeDetailPage'),
  registries: () => import('./docker/RegistriesPage'),
};
