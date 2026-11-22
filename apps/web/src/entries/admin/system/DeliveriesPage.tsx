import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { Badge, SeverityBadge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { type ColumnDef } from '@/ui/DataTable';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { MonitoringNav } from './MonitoringPage';

type Delivery = Row<'/api/v1/admin/notification-deliveries'>;
const STATES = ['queued', 'sending', 'sent', 'retrying', 'failed', 'blocked'] as const;

/** Nhật ký gửi thông báo ra kênh ngoài (D-103): lỗi, thử lại, bị chặn bởi SSRF guard, gửi lại. */
export default function DeliveriesPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const channels = useQuery({
    queryKey: ['admin', 'channels'],
    queryFn: () => list('/api/v1/admin/notification-channels'),
  });
  const resend = useAction(
    (d: Delivery) =>
      send('POST', '/api/v1/admin/notification-deliveries/{id}:resend', { path: { id: d.uuid } }),
    { success: t('deliveries.resent'), invalidate: [['admin', 'deliveries']] },
  );
  const columns: ColumnDef<Delivery, unknown>[] = [
    {
      id: 'title',
      header: t('deliveries.message'),
      accessorKey: 'title',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{row.original.title}</p>
          <p className="text-sm text-muted">
            {t(`events.${row.original.event_type}` as never, {
              defaultValue: row.original.event_type,
            })}
          </p>
        </div>
      ),
    },
    {
      id: 'channel',
      header: t('deliveries.channel'),
      accessorFn: (d) => d.channel.name,
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-0.5">
          <span>{row.original.channel.name}</span>
          <Badge tone="neutral">{t(`alerts.channel.${row.original.channel.type}`)}</Badge>
        </span>
      ),
    },
    {
      id: 'sev',
      header: t('sec.severity'),
      accessorKey: 'severity',
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    },
    {
      id: 'state',
      header: t('sites.status'),
      accessorKey: 'state',
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge status={row.original.state} />
          {row.original.error && (
            <span className="text-xs break-all text-danger-text">{row.original.error}</span>
          )}
          {row.original.next_retry_at && (
            <span className="text-xs text-muted">
              {t('deliveries.nextRetry', { at: fmt.time(row.original.next_retry_at) })}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'attempts',
      header: t('deliveries.attempts'),
      accessorKey: 'attempts',
      cell: ({ row }) => <span className="tabular-nums">{row.original.attempts}</span>,
    },
    {
      id: 'at',
      header: t('deliveries.at'),
      accessorKey: 'created_at',
      cell: ({ row }) => fmt.dateTime(row.original.created_at),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) =>
        row.original.state === 'failed' || row.original.state === 'blocked' ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={resend.isPending}
            onClick={() => resend.mutate(row.original)}
            aria-label={t('deliveries.resendFor', { name: row.original.title })}
          >
            {t('deliveries.resend')}
          </Button>
        ) : null,
    },
  ];
  return (
    <ListPage<Delivery>
      title={t('deliveries.title')}
      description={t('deliveries.description')}
      nav={<MonitoringNav current="deliveries" />}
      queryKey={['admin', 'deliveries']}
      fetch={(q) => list('/api/v1/admin/notification-deliveries', q)}
      columns={columns}
      getRowId={(d) => d.uuid}
      primaryColumnId="title"
      search
      filters={[
        {
          key: 'delivery_state',
          label: t('sites.status'),
          options: STATES.map((s) => ({
            value: s,
            label: t(`common:status.${s}` as never) as string,
          })),
        },
        {
          key: 'channel',
          label: t('deliveries.channel'),
          options: (channels.data ?? []).map((c) => ({ value: c.uuid, label: c.name })),
        },
      ]}
    />
  );
}
