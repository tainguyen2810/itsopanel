import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { useCrumbName } from '@/shared/routing/crumbs';
import { get } from '../api';
import { LIMIT_GROUPS, type Limits } from './packages';

export function useRouteId(): string {
  return (useParams({ strict: false }) as { id: string }).id;
}

/** Tài khoản hosting theo $id + tên cho breadcrumb. */
export function useAccount() {
  const id = useRouteId();
  const q = useQuery({
    queryKey: ['admin', 'account', id],
    queryFn: () => get('/api/v1/admin/hosting-accounts/{id}', { path: { id } }),
  });
  useCrumbName(id, q.data?.username);
  return { id, ...q };
}

/** Gói hosting theo $id + tên cho breadcrumb. */
export function usePackage() {
  const id = useRouteId();
  const q = useQuery({
    queryKey: ['admin', 'package', id],
    queryFn: () => get('/api/v1/admin/hosting-packages/{id}', { path: { id } }),
  });
  useCrumbName(id, q.data?.name);
  return { id, ...q };
}

/** Định dạng một giá trị giới hạn theo đơn vị. */
export function useLimitText() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  return (key: keyof Limits, l: Limits): string => {
    const v = l[key];
    const f = LIMIT_GROUPS.flatMap((g) => g.fields).find((x) => x.name === key);
    if (typeof v === 'number') {
      if (f?.unit === 'mb') return fmt.mb(v);
      if (f?.unit === 'pct') return `${fmt.num(v)}%`;
      if (f?.unit === 'min') return t('packages.minutes', { count: v });
      if (key === 'retention_days_after_terminate') return t('packages.days', { count: v });
      return fmt.num(v);
    }
    if (typeof v === 'boolean') return v ? t('packages.yes') : t('packages.no');
    if (Array.isArray(v)) return v.join(', ');
    if (v === null) return t('packages.unlimited');
    if (key === 'backup_retention') {
      const r = l.backup_retention;
      return t('packages.retentionValue', r);
    }
    return String(v);
  };
}

/** Thứ tự hiển thị đầy đủ của các giới hạn. */
export const LIMIT_KEYS: (keyof Limits)[] = [
  ...LIMIT_GROUPS.flatMap((g) => g.fields.map((f) => f.name)),
  'io_read_bps',
  'io_write_bps',
  'backup_retention',
  'ssh_allowed',
  'php_versions',
  'retention_days_after_terminate',
];

export { UsageList } from '@/shared/hosting/pages/usage';
