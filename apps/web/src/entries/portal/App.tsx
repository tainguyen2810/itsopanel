import { useTranslation } from 'react-i18next';
import { HealthRow } from '@/shared/components/HealthRow';
import { StatusPanel } from '@/shared/components/StatusPanel';
import { DEMO_USER } from '@/shared/demo';
import { PortalShell } from '@/shared/shell/AppShell';

/**
 * Portal: app shell + chỉ health API.
 * Chi tiết agent/hạ tầng là thông tin Admin-only, không lộ qua portal (realm separation).
 */
export function App() {
  const { t } = useTranslation('shell');
  return (
    <PortalShell
      activeKey="overview"
      user={DEMO_USER}
      unread={1}
      storage={{ used: '3,1 GB', total: '10 GB', ratio: 0.31 }}
    >
      <h1 className="mb-4 text-2xl font-semibold">{t('nav.overview')}</h1>
      <StatusPanel>
        <HealthRow />
      </StatusPanel>
    </PortalShell>
  );
}
