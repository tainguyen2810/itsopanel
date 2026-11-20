import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ProgressBar } from '@/ui/ProgressBar';
import type { Data } from '@/shared/api/realm';

type Usage = Data<'/hosting-accounts/{id}/usage'>;

/** Phần trăm đã dùng so với giới hạn (0 khi chưa có giới hạn). */
export const usagePct = (used: number, limit: number) => (limit > 0 ? (used * 100) / limit : 0);

/** Bảng mức dùng tài nguyên của account so với giới hạn gói. */
export function UsageList({ usage }: { usage: Usage }) {
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
            value={usagePct(used, limit)}
            thresholds={{ warn: 75, danger: 90 }}
          />
        </li>
      ))}
    </ul>
  );
}
