import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { StatusBadge } from '@/ui/Badge';
import { AreaChart } from '@/ui/Charts';
import { InfoList } from '@/shared/page/InfoList';

export interface UptimeView {
  url: string;
  state?: 'up' | 'down' | 'unknown' | 'paused';
  keyword?: string | null;
  interval_sec: number;
  uptime_24h?: number;
  uptime_7d?: number;
  uptime_30d: number;
  cert_expires_at?: string | null;
  last_error?: string | null;
  down_since?: string | null;
}

export interface UptimeResultRow {
  at: string;
  ok: boolean;
  status: number | null;
  latency_ms: number | null;
  error: string | null;
}

/** Ngày còn lại tới hạn chứng chỉ (âm = đã hết hạn). */
export function certDays(iso: string | null | undefined, now = Date.now()): number | null {
  return iso ? Math.floor((new Date(iso).getTime() - now) / 86_400_000) : null;
}

/** Chi tiết một uptime check: thông số, biểu đồ độ trễ, các lần lỗi gần đây (dùng chung Admin/Portal). */
export function UptimeResults({
  check,
  results,
}: {
  check: UptimeView;
  results: UptimeResultRow[];
}) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const sorted = [...results].sort((a, b) => a.at.localeCompare(b.at));
  const failures = sorted.filter((r) => !r.ok).reverse();
  const days = certDays(check.cert_expires_at);
  return (
    <div className="flex flex-col gap-4">
      <InfoList
        items={[
          [t('uptime.url'), <span className="break-all">{check.url}</span>],
          [t('sites.status'), check.state ? <StatusBadge status={check.state} /> : '—'],
          [t('uptime.interval'), fmt.duration(check.interval_sec)],
          [t('uptime.keyword'), check.keyword ?? t('uptime.noKeyword')],
          [
            t('uptime.ratio'),
            [check.uptime_24h, check.uptime_7d, check.uptime_30d]
              .map((v, i) =>
                v === undefined ? null : `${t(`uptime.window.${i as 0 | 1 | 2}`)} ${fmt.pct(v, 2)}`,
              )
              .filter(Boolean)
              .join(' · '),
          ],
          [
            t('uptime.cert'),
            days === null
              ? '—'
              : t('uptime.certDays', { date: fmt.date(check.cert_expires_at ?? ''), count: days }),
          ],
          ...(check.down_since
            ? ([[t('uptime.downSince'), fmt.dateTime(check.down_since)]] as [string, string][])
            : []),
        ]}
      />
      <AreaChart
        ariaLabel={t('uptime.latencyAria', { url: check.url })}
        data={sorted.map((r) => ({
          time: r.at.slice(11, 16),
          latency: r.ok ? r.latency_ms : null,
        }))}
        xKey="time"
        unit=" ms"
        height={180}
        series={[{ key: 'latency', label: t('uptime.latency') }]}
      />
      <div>
        <h3 className="mb-2 font-medium">{t('uptime.failures')}</h3>
        {failures.length === 0 ? (
          <p className="text-sm text-muted">{t('uptime.noFailures')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {failures.map((r) => (
              <li key={r.at} className="flex flex-wrap gap-x-3">
                <span className="tabular-nums text-muted">{fmt.dateTime(r.at)}</span>
                <span className="text-danger-text">{r.error ?? r.status ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
