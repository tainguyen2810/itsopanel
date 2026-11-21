import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { Mono } from './common';

/** Cột bảng file nghi nhiễm, dùng chung Admin (Mã độc) và Portal (Bảo mật). */
export function useFindingColumns<
  F extends {
    uuid: string;
    path: string;
    signature: string;
    engine: string;
    action: string;
    found_at: string;
    hosting_account: { username: string };
  },
>(onQuarantine: (f: F) => void, pending: boolean, extra?: (f: F) => ReactNode) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const cols: ColumnDef<F, unknown>[] = [
    {
      id: 'path',
      header: t('sec.filePath'),
      accessorKey: 'path',
      cell: ({ row }) => (
        <div className="min-w-0">
          <Mono>{row.original.path}</Mono>
          <p className="text-sm text-muted">
            {row.original.hosting_account.username} · {fmt.rel(row.original.found_at)}
          </p>
        </div>
      ),
    },
    {
      id: 'sig',
      header: t('sec.signature'),
      accessorKey: 'signature',
      cell: ({ row }) => (
        <div className="flex flex-col">
          <Mono>{row.original.signature}</Mono>
          <span className="text-sm text-muted">{row.original.engine}</span>
        </div>
      ),
    },
    {
      id: 'action',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) =>
        row.original.action === 'none' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onQuarantine(row.original)}
            >
              {t('sec.quarantineFile')}
            </Button>
            {extra?.(row.original)}
          </div>
        ) : (
          <Badge tone={row.original.action === 'deleted' ? 'neutral' : 'warning'}>
            {t(
              `sec.findingAction.${row.original.action as 'quarantined' | 'restored' | 'deleted'}`,
            )}
          </Badge>
        ),
    },
  ];
  return cols;
}
