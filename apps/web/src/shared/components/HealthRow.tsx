import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { unwrap } from '@/api/http';
import { publicApi } from '@/api/public';
import { StatusRow } from './StatusRow';

/** Dòng "API": gọi GET /api/v1/system/health (public, dùng chung cho admin và portal). */
export function HealthRow() {
  const { t } = useTranslation('status');
  const q = useQuery({
    queryKey: ['system', 'health'],
    queryFn: async () => unwrap(await publicApi.GET('/api/v1/system/health')),
  });
  if (q.isPending) return <StatusRow id="API" label={t('api')} state="loading" />;
  if (q.isError)
    return <StatusRow id="API" label={t('api')} state="error" detail={q.error.message} />;
  return <StatusRow id="API" label={t('api')} state="ok" detail={`health: ${q.data.status}`} />;
}
