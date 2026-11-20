import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/shared/page/PageHeader';
import { send } from '../api';
import { useAction } from '../useAction';
import { PackageForm } from './PackageForm';
import { DEFAULT_LIMITS, type Package, type PackageForm as Form } from './packages';

export default function PackageNewPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const create = useAction(
    (v: Form) =>
      send<Package>('POST', '/api/v1/admin/hosting-packages', {
        body: { ...v, description: v.description || null },
      }),
    {
      success: t('packages.created'),
      invalidate: [['admin', 'packages']],
      onSuccess: (p) => void navigate({ to: `/hosting-packages/${p.uuid}` }),
    },
  );
  return (
    <>
      <PageHeader title={t('packages.addTitle')} description={t('packages.addDescription')} />
      <PackageForm
        defaultValues={{
          code: '',
          name: '',
          description: '',
          limits: DEFAULT_LIMITS as Form['limits'],
        }}
        pending={create.isPending}
        submitLabel={t('packages.create')}
        onSubmit={(v) => create.mutate(v)}
        onCancel={() => void navigate({ to: '/hosting-packages' })}
      />
    </>
  );
}
