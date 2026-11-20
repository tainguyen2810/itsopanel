import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { getJson, type SystemStatus } from '@/shared/api/client';
import { HealthRow } from '@/shared/components/HealthRow';
import { StatusPanel } from '@/shared/components/StatusPanel';
import { StatusRow } from '@/shared/components/StatusRow';
import { DEMO_ADMIN } from '@/shared/demo';
import { AdminShell } from '@/shared/shell/AppShell';

function ms(v: number | null): string {
  return v === null ? '' : ` · ${v.toFixed(1)} ms`;
}

/** Admin: app shell + trạng thái môi trường dev (GET /api/v1/admin/system/status). Trang module ở Phase 2. */
export function App() {
  const { t } = useTranslation('status');
  const { t: ts } = useTranslation('shell');
  const q = useQuery({
    queryKey: ['admin', 'system', 'status'],
    queryFn: () => getJson<SystemStatus>('/api/v1/admin/system/status'),
  });
  const err = q.isError ? q.error.message : undefined;
  const s = q.data;
  const pending = (id: string, label: string) => (
    <StatusRow id={id} label={label} state={err ? 'error' : 'loading'} detail={err} />
  );
  return (
    <AdminShell
      activeKey="dashboard"
      user={DEMO_ADMIN}
      unread={3}
      storage={{ used: '2,4 TB', total: '6 TB', ratio: 0.4 }}
    >
      <h1 className="mb-4 text-2xl font-semibold">{ts('nav.dashboard')}</h1>
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
    </AdminShell>
  );
}
