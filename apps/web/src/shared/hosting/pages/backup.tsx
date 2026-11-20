import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { Badge } from '@/ui/Badge';
import type { Row } from '@/shared/api/realm';
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
