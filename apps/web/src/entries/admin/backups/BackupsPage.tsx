import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/shared/page/PageHeader';
import { useUrlState } from '@/shared/page/useUrlState';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/Tabs';
import { DestinationsTab } from './DestinationsTab';
import { PoliciesTab } from './PoliciesTab';
import { OverviewTab } from './OverviewTab';
import { SnapshotsTab, VerifyTab } from './SnapshotsTab';

const TABS = ['overview', 'history', 'policies', 'destinations', 'verify'] as const;

export default function BackupsPage() {
  const { t } = useTranslation('admin');
  const [url, setUrl] = useUrlState();
  const tab = (TABS as readonly string[]).includes(url.tab ?? '')
    ? (url.tab as string)
    : 'overview';
  return (
    <>
      <PageHeader title={t('bk.title')} description={t('bk.description')} />
      <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === 'overview' ? undefined : v })}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList>
            {TABS.map((k) => (
              <TabsTrigger key={k} value={k}>
                {t(`bk.tabs.${k}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <SnapshotsTab />
        </TabsContent>
        <TabsContent value="policies" className="mt-4">
          <PoliciesTab />
        </TabsContent>
        <TabsContent value="destinations" className="mt-4">
          <DestinationsTab />
        </TabsContent>
        <TabsContent value="verify" className="mt-4">
          <VerifyTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
