import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { InfoList } from '@/shared/page/InfoList';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { CodeBlock } from '@/ui/CodeBlock';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { get, type Data } from '../api';
import { SystemNav } from './SystemNav';

type Updates = Data<'/api/v1/admin/system/updates'>;
type Run = Updates['history'][number];

/**
 * Cập nhật panel (D-65, D-114): panel không tự cập nhật; trang hiện phiên bản, kênh, lịch sử update/rollback và
 * cảnh báo journal dở dang (sau mất điện) kèm lệnh `itso repair` chạy bằng root trên máy chủ.
 */
export default function UpdatesPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'system', 'updates'],
    queryFn: () => get('/api/v1/admin/system/updates'),
  });
  const header = (
    <PageHeader
      title={t('updates.title')}
      description={t('updates.description')}
      nav={<SystemNav current="updates" />}
    />
  );
  if (q.isLoading)
    return (
      <>
        {header}
        <PageSkeleton />
      </>
    );
  if (q.error || !q.data)
    return (
      <>
        {header}
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  const u = q.data;
  const columns: ColumnDef<Run, unknown>[] = [
    {
      id: 'started_at',
      header: t('updates.at'),
      accessorKey: 'started_at',
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{fmt.dateTime(row.original.started_at)}</span>
      ),
    },
    {
      id: 'action',
      header: t('updates.action'),
      accessorKey: 'action',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{t(`updates.actions.${row.original.action}`)}</p>
          <p className="font-mono text-sm text-muted">
            {row.original.version_from} → {row.original.version_to}
          </p>
        </div>
      ),
    },
    {
      id: 'result',
      header: t('updates.result'),
      accessorKey: 'result',
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge status={row.original.result} />
          {row.original.note && <span className="text-sm text-muted">{row.original.note}</span>}
        </span>
      ),
    },
    {
      id: 'duration',
      header: t('updates.duration'),
      accessorKey: 'duration_sec',
      cell: ({ row }) =>
        row.original.duration_sec === null ? '—' : fmt.duration(row.original.duration_sec),
    },
    { id: 'by', header: t('updates.by'), accessorKey: 'by' },
  ];
  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        {u.journal && (
          <Alert
            tone="danger"
            title={t('updates.journalTitle', {
              version: u.journal.version_to,
              step: t(`updates.steps.${u.journal.step}`),
            })}
          >
            <p>{u.journal.hint}</p>
            <CodeBlock code={u.repair_command} className="mt-2" />
          </Alert>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title={t('updates.current')} />
            <CardContent>
              <InfoList
                items={[
                  [t('updates.version'), <span className="font-mono">{u.current_version}</span>],
                  [t('updates.commit'), <span className="font-mono">{u.commit}</span>],
                  [
                    t('updates.channel'),
                    <Badge tone="info">{t(`updates.channels.${u.channel}`)}</Badge>,
                  ],
                  [
                    t('updates.latest'),
                    u.update_available && u.latest_version ? (
                      <Badge tone="warning">
                        {t('updates.available', { version: u.latest_version })}
                      </Badge>
                    ) : (
                      t('updates.upToDate')
                    ),
                  ],
                  [t('updates.checkedAt'), fmt.opt(u.checked_at)],
                  [
                    t('updates.releases'),
                    <span className="flex flex-wrap gap-1.5">
                      {u.releases.map((r) => (
                        <Badge key={r.version} tone={r.active ? 'success' : 'neutral'}>
                          {r.version}
                          {r.active ? ` · ${t('updates.active')}` : ''}
                        </Badge>
                      ))}
                    </span>,
                  ],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader title={t('updates.howTitle')} description={t('updates.howHint')} />
            <CardContent className="flex flex-col gap-3">
              <div>
                <p className="mb-1 text-sm font-medium">{t('updates.updateCmd')}</p>
                <CodeBlock code={u.update_command} />
              </div>
              <div>
                <p className="mb-1 text-sm font-medium">{t('updates.repairCmd')}</p>
                <CodeBlock code={u.repair_command} />
              </div>
              <p className="text-sm text-muted">{t('updates.offlineHint')}</p>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader title={t('updates.history')} description={t('updates.historyHint')} />
          <CardContent>
            <DataTable<Run>
              data={u.history}
              columns={columns}
              getRowId={(r) => `${r.started_at}-${r.action}`}
              primaryColumnId="action"
              caption={t('updates.history')}
              empty={t('updates.noHistory')}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
