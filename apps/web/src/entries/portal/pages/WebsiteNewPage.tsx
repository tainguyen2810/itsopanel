import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { WebsiteCreateCard } from '@/shared/hosting/pages/WebsitesPage';
import { PageHeader } from '@/shared/page/PageHeader';

/** Tạo website (Portal): form trên trang riêng; xong thì về danh sách, job hiện ở ngăn theo dõi. */
export default function WebsiteNewPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  return (
    <>
      <PageHeader title={t('sites.addTitle')} description={t('sites.addHint')} />
      <WebsiteCreateCard onCreated={() => void navigate({ to: '/websites' })} />
    </>
  );
}
