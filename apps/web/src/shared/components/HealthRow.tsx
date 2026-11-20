import { useQuery } from '@tanstack/react-query';
import { getJson, type Health } from '@/shared/api/client';
import { StatusRow } from './StatusRow';

/** Dòng "API": gọi GET /api/v1/system/health (public, dùng chung cho admin và portal). */
export function HealthRow() {
  const q = useQuery({
    queryKey: ['system', 'health'],
    queryFn: () => getJson<Health>('/api/v1/system/health'),
  });
  if (q.isPending) return <StatusRow label="API" state="loading" />;
  if (q.isError) return <StatusRow label="API" state="error" detail={q.error.message} />;
  return <StatusRow label="API" state="ok" detail={`health: ${q.data.status}`} />;
}
