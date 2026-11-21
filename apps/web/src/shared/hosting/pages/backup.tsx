import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { Badge } from '@/ui/Badge';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { ProgressBar } from '@/ui/ProgressBar';
import { list, type Row } from '@/shared/api/realm';
import { verifyState } from '../backup';

export type Snapshot = Row<'/backup-snapshots'>;

/** Trạng thái kiểm chứng của snapshot (đã kiểm trong 7 ngày / quá hạn / chưa kiểm). */
export function VerifyBadge({ s }: { s: Snapshot }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const st = verifyState(s);
  return (
    <Badge tone={st === 'verified' ? 'success' : st === 'stale' ? 'warning' : 'neutral'}>
      {st === 'never'
        ? t('bk.verify.never')
        : t(`bk.verify.${st}`, { at: fmt.rel(s.verified_at ?? '') })}
    </Badge>
  );
}

/** Trạng thái quota backup theo gói (D-86): vượt quota → cảnh báo, vượt 120 % → tạm dừng backup lịch. */
export function quotaState(used: number, limit: number): 'ok' | 'warn' | 'paused' {
  if (limit <= 0 || used <= limit) return 'ok';
  return used > limit * 1.2 ? 'paused' : 'warn';
}

/** Thẻ quota backup của các account (Portal: account của mình; Admin: một account). */
export function BackupQuota({ account }: { account?: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'accounts', 'backup-quota', account ?? 'all'],
    queryFn: () => list('/hosting-accounts'),
  });
  const rows = (q.data ?? []).filter(
    (a) =>
      (account ? a.uuid === account : true) &&
      a.lifecycle_state !== 'terminated' &&
      a.lifecycle_state !== 'provisioning',
  );
  if (rows.length === 0) return null;
  return (
    <Card className="mb-4">
      <CardHeader title={t('bk.quotaTitle')} description={t('bk.quotaHint')} />
      <CardContent>
        <ul className="grid gap-4 md:grid-cols-2">
          {rows.map((a) => {
            const { used, limit } = a.usage.backup_mb;
            const st = quotaState(used, limit);
            return (
              <li key={a.uuid} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono font-medium">{a.username}</span>
                  {st !== 'ok' && (
                    <Badge tone={st === 'paused' ? 'danger' : 'warning'}>
                      {t(`bk.quota.${st}`)}
                    </Badge>
                  )}
                </div>
                <ProgressBar
                  value={used}
                  max={limit || 1}
                  label={t('bk.ov.quotaOf', { name: a.username })}
                  {...(st === 'ok'
                    ? { thresholds: { warn: 90, danger: 100 } }
                    : { tone: st === 'paused' ? ('danger' as const) : ('warning' as const) })}
                />
                <p className="text-sm text-muted">
                  {t('bk.quotaUsed', { used: fmt.mb(used), limit: fmt.mb(limit) })}
                  {st === 'paused' && ` · ${t('bk.quota.pausedHint')}`}
                </p>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
