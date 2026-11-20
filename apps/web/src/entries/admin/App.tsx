import { useMemo } from 'react';
import type { RouterHistory } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { adminApi } from '@/api/admin';
import { unwrap } from '@/api/http';
import { RoutedApp } from '@/shared/routing/RoutedApp';
import { ADMIN_PAGES } from './pages';
import { ADMIN_ROUTES } from './routes';
import { createSearch } from './search';

const fetchJob = async (id: string) =>
  unwrap(await adminApi.GET('/api/v1/admin/jobs/{id}', { params: { path: { id } } }));

/** Private Admin Panel: router theo sitemap, trang tải theo nhu cầu (code-split). */
export function App({ history }: { history?: RouterHistory }) {
  const { t } = useTranslation('admin');
  const search = useMemo(() => createSearch(t), [t]);
  return (
    <RoutedApp
      realm="admin"
      defs={ADMIN_ROUTES}
      pages={ADMIN_PAGES}
      homeId="dashboard"
      fetchJob={fetchJob}
      search={search}
      {...(history ? { history } : {})}
    />
  );
}
