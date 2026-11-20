import { useQuery } from '@tanstack/react-query';
import { getJson, type SystemStatus } from '@/shared/api/client';
import { HealthRow } from '@/shared/components/HealthRow';
import { ScaffoldPage } from '@/shared/components/ScaffoldPage';
import { StatusRow } from '@/shared/components/StatusRow';

function ms(v: number | null): string {
  return v === null ? '' : ` · ${v.toFixed(1)} ms`;
}

/** Trang tạm của Admin: health API + trạng thái PostgreSQL, Redis, agent (GET /api/v1/admin/system/status). */
export function App() {
  const q = useQuery({
    queryKey: ['admin', 'system', 'status'],
    queryFn: () => getJson<SystemStatus>('/api/v1/admin/system/status'),
  });
  const err = q.isError ? q.error.message : undefined;
  const s = q.data;
  return (
    <ScaffoldPage title="Private Admin Panel" subtitle="Trạng thái môi trường dev">
      <HealthRow />
      {s === undefined ? (
        <>
          <StatusRow label="Agent" state={err ? 'error' : 'loading'} detail={err} />
          <StatusRow label="PostgreSQL" state={err ? 'error' : 'loading'} detail={err} />
          <StatusRow label="Redis" state={err ? 'error' : 'loading'} detail={err} />
        </>
      ) : (
        <>
          <StatusRow
            label="Agent"
            state={s.agent.reachable ? 'ok' : 'error'}
            detail={
              s.agent.reachable
                ? `ping ${s.agent.mode ?? ''} ${s.agent.version ?? ''}${ms(s.agent.latency_ms)}`
                : (s.agent.error ?? 'không kết nối được')
            }
          />
          <StatusRow
            label="PostgreSQL"
            state={s.database.ok ? 'ok' : 'error'}
            detail={
              s.database.ok ? `OK${ms(s.database.latency_ms)}` : (s.database.error ?? undefined)
            }
          />
          <StatusRow
            label="Redis"
            state={s.redis.ok ? 'ok' : 'error'}
            detail={s.redis.ok ? `OK${ms(s.redis.latency_ms)}` : (s.redis.error ?? undefined)}
          />
        </>
      )}
    </ScaffoldPage>
  );
}
