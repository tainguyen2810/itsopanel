import { useQuery } from '@tanstack/react-query';
import { FileWarning } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ListPage } from '@/shared/page/ListPage';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { StatCard } from '@/ui/StatCard';
import { list } from '../api';
import { SecurityNav, useEventColumns, type SecEvent } from './common';

/** Đường dẫn FIM theo dõi (baseline do agent op fim.baseline tạo; thay đổi qua panel tự cập nhật baseline). */
const WATCHED = [
  '/etc/ssh',
  '/etc/nginx',
  '/etc/php',
  '/etc/sudoers.d',
  '/etc/passwd',
  '/etc/crontab',
  '/usr/local/bin',
];

export default function FimPage() {
  const { t } = useTranslation('admin');
  const columns = useEventColumns();
  const fetchFim = async () =>
    (await list('/api/v1/admin/security/events')).filter((e) => e.type.startsWith('fim.'));
  const all = useQuery({ queryKey: ['admin', 'security', 'events', 'fim'], queryFn: fetchFim });
  const open = (all.data ?? []).filter((e) => !e.acknowledged_at).length;
  return (
    <ListPage<SecEvent>
      title={t('sec.fimTitle')}
      description={t('sec.fimDescription')}
      nav={<SecurityNav current="fim" />}
      queryKey={['admin', 'security', 'events', 'fim', 'list']}
      fetch={async (q) =>
        (await list('/api/v1/admin/security/events', q)).filter((e) => e.type.startsWith('fim.'))
      }
      columns={columns}
      getRowId={(e) => e.uuid}
      primaryColumnId="message"
      empty={t('sec.fimEmpty')}
    >
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <StatCard
          icon={FileWarning}
          tone={open > 0 ? 'danger' : 'success'}
          label={t('sec.fimOpen')}
          value={String(open)}
          hint={t('sec.fimOpenHint')}
        />
        <Card>
          <CardHeader title={t('sec.fimWatched')} description={t('sec.fimWatchedHint')} />
          <CardContent>
            <ul className="flex flex-wrap gap-2">
              {WATCHED.map((p) => (
                <li key={p} className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-sm">
                  {p}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </ListPage>
  );
}
