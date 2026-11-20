import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RestoresList } from '@/shared/hosting/pages/RestoresList';
import { AppLink } from '@/ui/AppLink';
import { buttonVariants } from '@/ui/Button';

export default function RestoresPage() {
  const { t } = useTranslation('admin');
  return (
    <RestoresList
      actions={
        <AppLink href="/admin/restores/new" className={buttonVariants()}>
          <History aria-hidden />
          {t('rs.new')}
        </AppLink>
      }
    />
  );
}
