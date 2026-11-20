import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { HealthRow } from '@/shared/components/HealthRow';
import { StatusPanel } from '@/shared/components/StatusPanel';
import { StatusRow } from '@/shared/components/StatusRow';
import { get } from '../api';

function ms(v: number | null): string {
  return v === null ? '' : ` · ${v.toFixed(1)} ms`;
}

/** Trạng thái môi trường (API, agent, PostgreSQL, Redis) — GET /api/v1/admin/system/status. */
export function SystemStatusCard() {
  const { t } = useTranslation('status');
  const q = useQuery({
    queryKey: ['admin', 'system', 'status'],
    queryFn: () => get('/api/v1/admin/system/status'),
  });
  const err = q.isError ? q.error.message : undefined;
  const s = q.data;
  const pending = (id: string, label: string) => (
    <StatusRow id={id} label={label} state={err ? 'error' : 'loading'} detail={err} />
  );
  return (
    <div className="mt-4">
      <StatusPanel>
        <HealthRow />
        {s === undefined ? (
          <>
            {pending('Agent', t('agent'))}
            {pending('PostgreSQL', t('database'))}
            {pending('Redis', t('redis'))}
          </>
        ) : (
          <>
            <StatusRow
              id="Agent"
              label={t('agent')}
              state={s.agent.reachable ? 'ok' : 'error'}
              detail={
                s.agent.reachable
                  ? `ping ${s.agent.mode ?? ''} ${s.agent.version ?? ''}${ms(s.agent.latency_ms)}`
                  : (s.agent.error ?? t('unreachable'))
              }
            />
            <StatusRow
              id="PostgreSQL"
              label={t('database')}
              state={s.database.ok ? 'ok' : 'error'}
              detail={
                s.database.ok ? `OK${ms(s.database.latency_ms)}` : (s.database.error ?? undefined)
              }
            />
            <StatusRow
              id="Redis"
              label={t('redis')}
              state={s.redis.ok ? 'ok' : 'error'}
              detail={s.redis.ok ? `OK${ms(s.redis.latency_ms)}` : (s.redis.error ?? undefined)}
            />
          </>
        )}
      </StatusPanel>
    </div>
  );
}
