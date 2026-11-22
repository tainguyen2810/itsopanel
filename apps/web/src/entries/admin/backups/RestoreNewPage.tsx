import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { RestoreWizard } from '@/shared/hosting/pages/RestoreWizard';
import { PageHeader } from '@/shared/page/PageHeader';
import { useUrlState } from '@/shared/page/useUrlState';
import { list } from '../api';

/**
 * Khôi phục mới (Admin): wizard dùng chung + chọn server đích khi khôi phục ra bản mới (D-93: đích
 * đọc cùng repo backup, account được tạo ở đích nếu chưa có). Chỉ liệt kê node đang trực tuyến.
 */
export default function RestoreNewPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const [url] = useUrlState();
  const servers = useQuery({
    queryKey: ['admin', 'servers', 'options'],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  return (
    <>
      <PageHeader title={t('rs.newTitle')} description={t('rs.newDescription')} />
      <RestoreWizard
        snapshot={url.snapshot}
        targetServers={(servers.data ?? [])
          .filter((s) => s.status === 'ready' && s.connection === 'online')
          .map((s) => ({ value: s.uuid, label: s.name }))}
        onDone={() => void navigate({ to: '/restores' })}
      />
    </>
  );
}
