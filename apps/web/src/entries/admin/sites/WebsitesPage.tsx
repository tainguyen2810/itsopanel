import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import SharedWebsitesPage from '@/shared/hosting/pages/WebsitesPage';
import { list } from '../api';

/** Website (Admin): trang dùng chung + bộ lọc theo server (chỉ Admin có danh sách server). */
export default function WebsitesPage() {
  const { t } = useTranslation('admin');
  const servers = useQuery({
    queryKey: ['admin', 'servers', { q: '' }],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  return (
    <SharedWebsitesPage
      extraFilters={[
        {
          key: 'server',
          label: t('sites.server'),
          options: (servers.data ?? []).map((s) => ({ value: s.uuid, label: s.name })),
        },
      ]}
    />
  );
}
