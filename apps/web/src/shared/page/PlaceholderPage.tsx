import { Construction } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCurrentRoute, useRouteTitle } from '@/shared/routing/useBreadcrumbs';
import { EmptyState } from '@/ui/Feedback';
import { PageHeader } from './PageHeader';

/** Trang tạm cho route chưa hiện thực (thay dần bằng trang thật trong các prompt Phase 2). */
export function PlaceholderPage() {
  const { t } = useTranslation('pages');
  const { def } = useCurrentRoute();
  const title = useRouteTitle();
  const name = def ? title(def) : '';
  return (
    <>
      <PageHeader title={name} />
      <div className="rounded-lg border border-dashed border-border-strong">
        <EmptyState
          icon={Construction}
          title={t('placeholder.title')}
          description={t('placeholder.hint')}
        />
      </div>
    </>
  );
}
