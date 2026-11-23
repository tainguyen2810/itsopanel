import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScanSearch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ChoiceCard } from '@/shared/page/ChoiceCard';
import type { ColumnDef } from '@/ui/DataTable';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { list, send, type JobAccepted, type Row } from '../api';
import { useAction } from '../useAction';

export type Import = Row<'/api/v1/admin/imports'>;
export const SOURCES = ['aapanel', 'hestia', 'nginx'] as const;

/**
 * Import từ panel khác trên cùng máy (D-108): danh sách lượt import và nút quét nguồn mới. Quét chỉ đọc, máy nguồn
 * không bị sửa; mỗi lượt mở trang kế hoạch → chạy → báo cáo → cutover.
 */
export default function ImportsPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [scan, setScan] = useState(false);
  const columns: ColumnDef<Import, unknown>[] = [
    {
      id: 'source',
      header: t('imports.source'),
      accessorKey: 'source',
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/imports/${row.original.uuid}`}
            className="font-medium hover:underline"
          >
            {t(`imports.sources.${row.original.source}`)}
          </AppLink>
          {row.original.source_version && (
            <p className="text-sm text-muted">{row.original.source_version}</p>
          )}
        </div>
      ),
    },
    { id: 'server', header: t('sec.server'), accessorFn: (i) => i.server.name },
    {
      id: 'state',
      header: t('sites.status'),
      accessorKey: 'state',
      cell: ({ row }) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge status={row.original.state} />
          {row.original.error && (
            <span className="text-xs wrap-anywhere text-danger-text">{row.original.error}</span>
          )}
        </span>
      ),
    },
    {
      id: 'summary',
      header: t('imports.found'),
      enableSorting: false,
      cell: ({ row }) => {
        const s = row.original.summary;
        return (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="tabular-nums">
              {t('imports.summary', { sites: s.sites, dbs: s.databases, selected: s.selected })}
            </span>
            {s.warnings > 0 && (
              <Badge tone="warning">{t('imports.warningsCount', { count: s.warnings })}</Badge>
            )}
          </span>
        );
      },
    },
    {
      id: 'scanned_at',
      header: t('imports.scannedAt'),
      accessorKey: 'scanned_at',
      cell: ({ row }) =>
        row.original.scanned_at ? fmt.dateTime(row.original.scanned_at) : t('imports.scanning'),
    },
  ];
  return (
    <>
      <ListPage<Import>
        title={t('imports.title')}
        description={t('imports.description')}
        actions={
          <Button onClick={() => setScan(true)}>
            <ScanSearch aria-hidden />
            {t('imports.scan')}
          </Button>
        }
        queryKey={['admin', 'imports']}
        fetch={(q) => list('/api/v1/admin/imports', q)}
        columns={columns}
        getRowId={(i) => i.uuid}
        primaryColumnId="source"
        empty={t('imports.empty')}
      />
      <ScanDialog open={scan} onOpenChange={setScan} />
    </>
  );
}

function ScanDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('admin');
  const servers = useQuery({
    queryKey: ['admin', 'servers', 'imports'],
    enabled: open,
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const [source, setSource] = useState<(typeof SOURCES)[number]>('aapanel');
  const [server, setServer] = useState('');
  const pick = server || servers.data?.[0]?.uuid || '';
  const go = useAction(
    () => send<JobAccepted>('POST', '/api/v1/admin/imports', { body: { source, server: pick } }),
    { invalidate: [['admin', 'imports']], onSuccess: () => onOpenChange(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('imports.scanTitle')}
      description={t('imports.scanHint')}
      submitLabel={t('imports.scan')}
      pending={go.isPending || !pick}
      onSubmit={() => go.mutate()}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">{t('imports.source')}</legend>
        {SOURCES.map((s) => (
          <ChoiceCard
            key={s}
            name="imp-source"
            value={s}
            checked={source === s}
            onChange={(v) => setSource(v as (typeof SOURCES)[number])}
          >
            <span className="block font-medium">{t(`imports.sources.${s}`)}</span>
            <span className="block text-sm text-muted">{t(`imports.sourceHints.${s}`)}</span>
          </ChoiceCard>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="imp-server">{t('sec.server')}</Label>
        <Select
          id="imp-server"
          value={pick}
          onValueChange={setServer}
          options={(servers.data ?? []).map((x) => ({
            value: x.uuid,
            label: x.name,
            disabled: !x.agent_connected,
          }))}
        />
      </div>
    </FormDialog>
  );
}
