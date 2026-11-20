import { useTranslation } from 'react-i18next';
import { HealthRow } from '@/shared/components/HealthRow';
import { StatusPanel } from '@/shared/components/StatusPanel';
import { PageHeader } from '@/shared/page/PageHeader';

/** Tổng quan portal (tạm): health API. Prompt 2.7 hoàn thiện usage/quota. */
export default function OverviewPage() {
  const { t } = useTranslation('pages');
  return (
    <>
      <PageHeader title={t('portal.overview')} />
      <StatusPanel>
        <HealthRow />
      </StatusPanel>
    </>
  );
}
