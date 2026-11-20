import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { useCrumbName } from '@/shared/routing/crumbs';
import { ProgressBar } from '@/ui/ProgressBar';
import { get } from '../api';
import { pct } from '../servers/ServersPage';
import type { Account } from './accounts';
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

/** Bảng mức dùng tài nguyên của account so với giới hạn gói. */
export function UsageList({ usage }: { usage: Account['usage'] }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const rows: [string, number, number, string][] = [
    [t('accounts.usage.disk'), usage.disk_mb.used, usage.disk_mb.limit, 'mb'],
    [t('accounts.usage.inodes'), usage.inodes.used, usage.inodes.limit, ''],
    [t('accounts.usage.cpu'), usage.cpu_percent.used, usage.cpu_percent.limit, '%'],
    [t('accounts.usage.ram'), usage.ram_mb.used, usage.ram_mb.limit, 'mb'],
    [t('accounts.usage.websites'), usage.websites.used, usage.websites.limit, ''],
    [t('accounts.usage.databases'), usage.databases.used, usage.databases.limit, ''],
    [t('accounts.usage.ftp'), usage.ftp_accounts.used, usage.ftp_accounts.limit, ''],
    [t('accounts.usage.cron'), usage.cron_jobs.used, usage.cron_jobs.limit, ''],
    [t('accounts.usage.backup'), usage.backup_mb.used, usage.backup_mb.limit, 'mb'],
  ];
  const show = (v: number, unit: string) =>
    unit === 'mb' ? fmt.mb(v) : unit === '%' ? `${fmt.num(v)}%` : fmt.num(v);
  return (
    <ul className="flex flex-col gap-3">
      {rows.map(([label, used, limit, unit]) => (
        <li key={label} className="flex flex-col gap-1">
          <div className="flex justify-between gap-2 text-sm">
            <span>{label}</span>
            <span className="text-muted tabular-nums">
              {show(used, unit)} / {show(limit, unit)}
            </span>
          </div>
          <ProgressBar
            label={label}
            value={pct(used, limit)}
            thresholds={{ warn: 75, danger: 90 }}
          />
        </li>
      ))}
    </ul>
  );
}
