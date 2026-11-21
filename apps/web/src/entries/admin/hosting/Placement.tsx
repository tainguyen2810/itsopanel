import { useTranslation } from 'react-i18next';
import { ChoiceCard } from '@/shared/page/ChoiceCard';
import { Badge } from '@/ui/Badge';
import type { Row } from '../api';

export type Suggestion = Row<'/api/v1/admin/placement/suggestions'>;

/**
 * Gợi ý server (D-92): server đủ điều kiện chọn được, kèm lý do và % cam kết; server bị loại vẫn hiện
 * (không chọn được) cùng lý do loại, để admin biết vì sao.
 */
export function Placement({
  id,
  name,
  items,
  value,
  onChange,
  exclude,
}: {
  id?: string;
  name: string;
  items: Suggestion[];
  value: string;
  onChange: (uuid: string) => void;
  /** Server không được chọn (ví dụ server hiện tại khi chuyển account). */
  exclude?: string;
}) {
  const { t } = useTranslation('admin');
  const rows = items.filter((s) => s.server.uuid !== exclude);
  const ok = rows.filter((s) => s.eligible && s.accepting_new);
  const out = rows.filter((s) => !(s.eligible && s.accepting_new));
  return (
    <div className="flex flex-col gap-3">
      <div id={id} role="radiogroup" className="flex flex-col gap-2">
        {ok.length === 0 && <p className="text-base text-muted">{t('accounts.noEligible')}</p>}
        {ok.map((s, i) => (
          <ChoiceCard
            key={s.server.uuid}
            name={name}
            value={s.server.uuid}
            checked={value === s.server.uuid}
            onChange={onChange}
          >
            <span className="flex flex-wrap items-center gap-2 font-medium">
              {s.server.name}
              {i === 0 && <Badge tone="success">{t('accounts.recommended')}</Badge>}
              <span className="text-sm font-normal text-muted">
                {t('accounts.score', { score: s.score })} ·{' '}
                {t('accounts.commit', { pct: s.commit_pct })}
              </span>
            </span>
            <span className="block text-sm text-muted">{s.reasons.join(' · ')}</span>
          </ChoiceCard>
        ))}
      </div>
      {out.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted">{t('accounts.excluded')}</p>
          <ul className="flex flex-col gap-2">
            {out.map((s) => (
              <li
                key={s.server.uuid}
                className="rounded-md border border-dashed border-border px-3 py-2 text-sm"
              >
                <span className="font-medium">{s.server.name}</span>
                <span className="text-muted">
                  {' '}
                  ·{' '}
                  {(s.excluded_reasons.length
                    ? s.excluded_reasons
                    : [t('accounts.notAccepting')]
                  ).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
