import type { RouterHistory } from '@tanstack/react-router';
import { unwrap } from '@/api/http';
import { portalApi } from '@/api/portal';
import { RoutedApp } from '@/shared/routing/RoutedApp';
import { PORTAL_PAGES } from './pages';
import { PORTAL_ROUTES } from './routes';

const fetchJob = async (id: string) =>
  unwrap(await portalApi.GET('/api/v1/portal/jobs/{id}', { params: { path: { id } } }));

/**
 * User Hosting Portal: chỉ chức năng của USER. Chi tiết agent/hạ tầng là thông tin Admin-only,
 * không lộ qua portal (realm separation).
 */
export function App({ history }: { history?: RouterHistory }) {
  return (
    <RoutedApp
      realm="portal"
      defs={PORTAL_ROUTES}
      pages={PORTAL_PAGES}
      homeId="overview"
      fetchJob={fetchJob}
      {...(history ? { history } : {})}
    />
  );
}
