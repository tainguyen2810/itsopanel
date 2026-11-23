import { useTranslation } from 'react-i18next';
import { SectionNav } from '@/shared/page/SectionNav';

const SECTIONS = [
  { key: 'readiness', path: '/readiness' },
  { key: 'updates', path: '/updates' },
] as const;

/** Mục Hệ thống (Super Admin): sẵn sàng production, cập nhật panel. */
export function SystemNav({ current }: { current: (typeof SECTIONS)[number]['key'] }) {
  const { t } = useTranslation('admin');
  return (
    <SectionNav
      label={t('system.sections')}
      current={current}
      items={SECTIONS.map((s) => ({
        key: s.key,
        href: `/admin/system${s.path}`,
        label: t(`system.nav.${s.key}`),
      }))}
    />
  );
}
