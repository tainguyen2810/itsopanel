import type { RouterHistory } from '@tanstack/react-router';
import { adminApi } from '@/api/admin';
import { unwrap } from '@/api/http';
import { RoutedApp } from '@/shared/routing/RoutedApp';
import { ADMIN_PAGES } from './pages';
import { ADMIN_ROUTES } from './routes';

const fetchJob = async (id: string) =>
  unwrap(await adminApi.GET('/api/v1/admin/jobs/{id}', { params: { path: { id } } }));

/** Private Admin Panel: router theo sitemap, trang tải theo nhu cầu (code-split). */
export function App({ history }: { history?: RouterHistory }) {
  return (
    <RoutedApp
      realm="admin"
      defs={ADMIN_ROUTES}
      pages={ADMIN_PAGES}
      homeId="dashboard"
      fetchJob={fetchJob}
      {...(history ? { history } : {})}
    />
  );
}
