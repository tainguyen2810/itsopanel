import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import type { ColumnDef } from '@/ui/DataTable';
import { ProgressBar } from '@/ui/ProgressBar';
import { list, type Row } from '../api';
import { auditLabel } from '../labels';

type Job = Row<'/api/v1/admin/jobs'>;
const STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const;

export default function JobsPage() {
  const { t } = useTranslation('admin');
  const { t: tc } = useTranslation('common');
  const fmt = useFmt();
  const columns: ColumnDef<Job, unknown>[] = [
    {
      id: 'type',
      header: t('jobs.type'),
      accessorFn: (j) => auditLabel(t, j.type),
      cell: ({ row, getValue }) => (
        <AppLink href={`/admin/jobs/${row.original.uuid}`} className="font-medium hover:underline">
          {getValue<string>()}
        </AppLink>
      ),
    },
    { id: 'server', header: t('jobs.server'), accessorFn: (j) => j.server?.name ?? '—' },
    {
      id: 'state',
      header: t('jobs.state'),
      accessorKey: 'state',
      cell: ({ row }) => <StatusBadge status={row.original.state} />,
    },
    {
      id: 'progress',
      header: t('jobs.progress'),
      accessorKey: 'progress',
      cell: ({ row }) => (
        <div className="flex w-32 items-center gap-2">
          <ProgressBar
            label={t('jobs.progress')}
            value={row.original.progress}
            className="flex-1"
          />
          <span className="text-xs text-muted tabular-nums">{row.original.progress}%</span>
        </div>
      ),
    },
    { id: 'by', header: t('jobs.requestedBy'), accessorFn: (j) => j.requested_by?.name ?? '—' },
    {
      id: 'created',
      header: t('jobs.created'),
      accessorKey: 'created_at',
      cell: ({ row }) => (
        <time dateTime={row.original.created_at} title={fmt.dateTime(row.original.created_at)}>
          {fmt.rel(row.original.created_at)}
        </time>
      ),
    },
  ];
  return (
    <ListPage<Job>
      title={t('jobs.title')}
      description={t('jobs.description')}
      queryKey={['admin', 'jobs']}
      fetch={(q) => list('/api/v1/admin/jobs', q)}
      columns={columns}
      getRowId={(j) => j.uuid}
      primaryColumnId="type"
      filters={[
        {
          key: 'state',
          label: t('jobs.state'),
          options: STATES.map((s) => ({ value: s, label: tc(`status.${s}`) })),
        },
      ]}
    />
  );
}
