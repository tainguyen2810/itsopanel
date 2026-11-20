import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { RestoresList } from '@/shared/hosting/pages/RestoresList';
import { RestoreWizard } from '@/shared/hosting/pages/RestoreWizard';
import { SnapshotsTab } from '@/shared/hosting/pages/SnapshotsTab';
import { PageHeader } from '@/shared/page/PageHeader';
import { SectionNav } from '@/shared/page/SectionNav';
import { useUrlState } from '@/shared/page/useUrlState';

const TABS = ['history', 'restore', 'restores'] as const;
type Tab = (typeof TABS)[number];

/** Sao lưu (Portal): snapshot của account mình, khôi phục (wizard), lịch sử khôi phục. */
export default function BackupsPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const [url] = useUrlState();
  const tab: Tab = (TABS as readonly string[]).includes(url.tab ?? '')
    ? (url.tab as Tab)
    : 'history';
  const go = (to: Tab, extra: Record<string, string> = {}) =>
    void navigate({ to: '/backups', search: { tab: to, ...extra } } as never);
  return (
    <>
      <PageHeader
        title={t('pt.backups')}
        description={t('pt.backupsHint')}
        nav={
          <SectionNav
            label={t('pt.backups')}
            current={tab}
            items={TABS.map((k) => ({
              key: k,
              href: `/portal/backups?tab=${k}`,
              label: t(`pt.backupTabs.${k}`),
            }))}
          />
        }
      />
      {tab === 'history' && <SnapshotsTab onRestore={(s) => go('restore', { snapshot: s.uuid })} />}
      {tab === 'restore' && (
        <RestoreWizard
          key={url.snapshot ?? 'none'}
          snapshot={url.snapshot}
          onDone={() => go('restores')}
        />
      )}
      {tab === 'restores' && <RestoresList embedded />}
    </>
  );
}
