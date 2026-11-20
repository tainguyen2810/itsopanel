import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useFmt } from '@/shared/format/useFmt';
import { downloadText } from '@/shared/lib/csv';
import { ListPage } from '@/shared/page/ListPage';
import { InfoList } from '@/shared/page/InfoList';
import { useUrlState } from '@/shared/page/useUrlState';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { getText, list, type Row } from '../api';
import { auditLabel, resourceHref } from '../labels';
import { errorText } from '../useAction';

type Audit = Row<'/api/v1/admin/audit-logs'>;

/** Bảng thay đổi: {field: [cũ, mới]} hoặc giá trị đơn. */
export function changeRows(changes: Record<string, unknown> | null): [string, string, string][] {
  const show = (v: unknown) =>
    v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v);
  return Object.entries(changes ?? {}).map(([k, v]) =>
    Array.isArray(v) && v.length === 2 ? [k, show(v[0]), show(v[1])] : [k, '', show(v)],
  );
}

export default function AuditPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [url] = useUrlState();
  const [detail, setDetail] = useState<Audit | null>(null);
  const [exporting, setExporting] = useState(false);
  const all = useQuery({
    queryKey: ['admin', 'audit', 'facets'],
    queryFn: () => list('/api/v1/admin/audit-logs'),
  });
  const actions = [...new Set((all.data ?? []).map((a) => a.action))].sort();
  const actors = new Map(
    (all.data ?? []).flatMap((a) => (a.actor ? [[a.actor.uuid, a.actor.name] as const] : [])),
  );
  const exportCsv = async () => {
    setExporting(true);
    try {
      const csv = await getText('/api/v1/admin/audit-logs/export', {
        'filter[action]': url.action,
        'filter[actor]': url.actor,
      });
      downloadText(`audit-logs-${new Date().toISOString().slice(0, 10)}.csv`, csv);
      toast.success(t('audit.exported', { count: Math.max(0, csv.trim().split('\n').length - 1) }));
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setExporting(false);
    }
  };
  const columns: ColumnDef<Audit, unknown>[] = [
    {
      id: 'at',
      header: t('audit.at'),
      accessorKey: 'at',
      cell: ({ row }) => <span className="whitespace-nowrap">{fmt.dateTime(row.original.at)}</span>,
    },
    {
      id: 'actor',
      header: t('audit.actor'),
      accessorFn: (a) => a.actor?.name ?? '',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="break-all">{row.original.actor?.name ?? t('audit.system')}</p>
          {row.original.impersonator && (
            <p className="text-sm text-warning-text">
              {t('audit.via', { name: row.original.impersonator.name })}
            </p>
          )}
          <p className="font-mono text-xs text-muted">{row.original.actor_ip}</p>
        </div>
      ),
    },
    {
      id: 'action',
      header: t('audit.action'),
      accessorKey: 'action',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p>{auditLabel(t, row.original.action)}</p>
          <p className="font-mono text-xs text-muted">{row.original.action}</p>
        </div>
      ),
    },
    {
      id: 'resource',
      header: t('audit.resource'),
      accessorFn: (a) => a.resource?.type ?? '',
      cell: ({ row }) => {
        const r = row.original.resource;
        if (!r) return '—';
        const label = t(`audit.types.${r.type}` as never, { defaultValue: r.type });
        const href = resourceHref(r);
        return href ? (
          <AppLink href={href} className="hover:underline">
            {label}
          </AppLink>
        ) : (
          label
        );
      },
    },
    { id: 'server', header: t('sites.server'), accessorFn: (a) => a.server?.name ?? '—' },
    {
      id: 'result',
      header: t('audit.result'),
      accessorKey: 'result',
      cell: ({ row }) => <StatusBadge status={row.original.result} />,
    },
    {
      id: 'detail',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setDetail(row.original)}
          aria-label={t('audit.detailFor', { action: row.original.action })}
        >
          {t('audit.detail')}
        </Button>
      ),
    },
  ];
  return (
    <>
      <ListPage<Audit>
        title={t('audit.title')}
        description={t('audit.description')}
        actions={
          <Button variant="outline" onClick={() => void exportCsv()} disabled={exporting}>
            <Download aria-hidden />
            {t('audit.export')}
          </Button>
        }
        queryKey={['admin', 'audit']}
        fetch={async (q) => {
          const rows = await list('/api/v1/admin/audit-logs', {
            ...q,
            filters: Object.fromEntries(Object.entries(q.filters).filter(([k]) => k !== 'result')),
          });
          return q.filters.result ? rows.filter((r) => r.result === q.filters.result) : rows;
        }}
        filters={[
          {
            key: 'action',
            label: t('audit.action'),
            options: actions.map((a) => ({ value: a, label: auditLabel(t, a) })),
          },
          {
            key: 'actor',
            label: t('audit.actor'),
            options: [...actors].map(([value, label]) => ({ value, label })),
          },
          {
            key: 'result',
            label: t('audit.result'),
            options: (['success', 'failure', 'denied'] as const).map((r) => ({
              value: r,
              label: t(`common:status.${r}` as never) as string,
            })),
          },
        ]}
        columns={columns}
        getRowId={(a) => a.uuid}
        primaryColumnId="action"
      />
      <Dialog open={detail !== null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent
          title={detail ? auditLabel(t, detail.action) : ''}
          description={detail ? fmt.dateTime(detail.at) : ''}
          className="max-w-2xl"
        >
          {detail && (
            <div className="flex flex-col gap-4">
              <InfoList
                items={[
                  [
                    t('audit.actor'),
                    `${detail.actor?.name ?? t('audit.system')} (${detail.actor?.email ?? '—'})`,
                  ],
                  ...(detail.impersonator
                    ? [[t('audit.impersonator'), detail.impersonator.name] as [string, string]]
                    : []),
                  [t('audit.ip'), detail.actor_ip ?? '—'],
                  [
                    t('audit.action'),
                    <code key="a" className="font-mono text-sm">
                      {detail.action}
                    </code>,
                  ],
                  [
                    t('audit.resource'),
                    detail.resource ? `${detail.resource.type} · ${detail.resource.uuid}` : '—',
                  ],
                  [t('sites.server'), detail.server?.name ?? '—'],
                  [t('audit.result'), <StatusBadge key="r" status={detail.result} />],
                  ...(detail.job_uuid
                    ? [
                        [
                          t('audit.job'),
                          <AppLink
                            key="j"
                            href={`/admin/jobs/${detail.job_uuid}`}
                            className="hover:underline"
                          >
                            {detail.job_uuid}
                          </AppLink>,
                        ] as [string, ReactNode],
                      ]
                    : []),
                  [
                    t('audit.hash'),
                    <code key="h" className="font-mono text-xs break-all">
                      {detail.hash}
                    </code>,
                  ],
                ]}
              />
              <div>
                <h3 className="mb-2 font-semibold">{t('audit.changes')}</h3>
                {changeRows(detail.changes).length === 0 ? (
                  <p className="text-sm text-muted">{t('audit.noChanges')}</p>
                ) : (
                  <div className="relative overflow-x-auto">
                    <table className="w-full text-sm">
                      <caption className="sr-only">{t('audit.changes')}</caption>
                      <thead>
                        <tr className="border-b border-border text-left text-muted">
                          <th scope="col" className="py-1 pr-2 font-medium">
                            {t('audit.field')}
                          </th>
                          <th scope="col" className="py-1 pr-2 font-medium">
                            {t('audit.before')}
                          </th>
                          <th scope="col" className="py-1 font-medium">
                            {t('audit.after')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {changeRows(detail.changes).map(([k, a, b]) => (
                          <tr key={k} className="border-b border-border align-top">
                            <th scope="row" className="py-1 pr-2 text-left font-mono font-normal">
                              {k}
                            </th>
                            <td className="py-1 pr-2 break-all text-muted">{a || '—'}</td>
                            <td className="py-1 break-all">{b}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <Badge tone="neutral" className="self-start">
                {t('audit.chainNote')}
              </Badge>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
