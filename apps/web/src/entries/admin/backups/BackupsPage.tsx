import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/shared/page/PageHeader';
import { useUrlState } from '@/shared/page/useUrlState';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/Tabs';
import { list } from '../api';
import { DestinationsTab } from './DestinationsTab';
import { PoliciesTab } from './PoliciesTab';
import { rule32110 } from './rules';
import { SnapshotsTab, VerifyTab } from './SnapshotsTab';

const TABS = ['history', 'policies', 'destinations', 'verify'] as const;

export default function BackupsPage() {
  const { t } = useTranslation('admin');
  const [url, setUrl] = useUrlState();
  const tab = (TABS as readonly string[]).includes(url.tab ?? '') ? (url.tab as string) : 'history';
  return (
    <>
      <PageHeader title={t('bk.title')} description={t('bk.description')} />
      <Checklist />
      <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === 'history' ? undefined : v })}>
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <TabsList>
            {TABS.map((k) => (
              <TabsTrigger key={k} value={k}>
                {t(`bk.tabs.${k}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
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

/** Checklist 3-2-1-1-0 tính từ đích, snapshot và chính sách hiện có. */
function Checklist() {
  const { t } = useTranslation('admin');
  const q = useQuery({
    queryKey: ['admin', 'backups', '32110'],
    queryFn: async () => {
      const [d, s, p] = await Promise.all([
        list('/api/v1/admin/backup-destinations'),
        list('/api/v1/admin/backup-snapshots'),
        list('/api/v1/admin/backup-policies'),
      ]);
      return rule32110(d, s, p);
    },
  });
  const rules = q.data ?? [];
  const passed = rules.filter((r) => r.ok).length;
  return (
    <Card className="mb-4">
      <CardHeader
        title={t('bk.rule.title')}
        description={
          q.data ? t('bk.rule.summary', { passed, total: rules.length }) : t('bk.rule.hint')
        }
      />
      <CardContent>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {rules.map((r) => (
            <li key={r.key} className="flex gap-2 rounded-lg border border-border p-3">
              {r.ok ? (
                <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-success-text" />
              ) : (
                <XCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-danger-text" />
              )}
              <div className="min-w-0">
                <p className="font-medium">
                  <span className="sr-only">{r.ok ? t('bk.rule.ok') : t('bk.rule.fail')}: </span>
                  {t(`bk.rule.${r.key}.title`)}
                </p>
                <p className="text-sm text-muted">
                  {t(`bk.rule.${r.key}.value`, { count: r.value })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
