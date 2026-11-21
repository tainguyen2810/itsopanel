import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { RestoreWizard } from '@/shared/hosting/pages/RestoreWizard';
import { PageHeader } from '@/shared/page/PageHeader';
import { useUrlState } from '@/shared/page/useUrlState';

/** Khôi phục mới (Admin): wizard dùng chung, khôi phục trên server hiện tại của account (sang server khác: Phase 9). */
export default function RestoreNewPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const [url] = useUrlState();
  return (
    <>
      <PageHeader title={t('rs.newTitle')} description={t('rs.newDescription')} />
      <RestoreWizard snapshot={url.snapshot} onDone={() => void navigate({ to: '/restores' })} />
    </>
  );
}
