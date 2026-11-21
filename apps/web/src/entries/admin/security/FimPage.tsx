import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Camera, FileWarning } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ListPage } from '@/shared/page/ListPage';
import { FormDialog } from '@/shared/page/FormDialog';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Badge, type Tone } from '@/ui/Badge';
import type { ColumnDef } from '@/ui/DataTable';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { StatCard } from '@/ui/StatCard';
import { useFmt } from '@/shared/format/useFmt';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { SecurityNav } from './common';

type Change = Row<'/api/v1/admin/security/fim/changes'>;

const CHANGE_TONE: Record<Change['change'], Tone> = {
  added: 'danger',
  modified: 'warning',
  removed: 'danger',
  metadata: 'neutral',
};

/**
 * Đường dẫn FIM theo dõi (D-80): baseline do agent giữ (`fim.baseline`), panel bị chiếm cũng không sửa được;
 * thay đổi qua panel tự cập nhật baseline.
 */
const WATCHED = [
  '/etc/ssh',
  '/etc/nginx',
  '/etc/itso',
  '/etc/sudoers.d',
  '/etc/passwd',
  '/etc/systemd/system/itso*',
  '/opt/itso',
  '/usr/local/bin',
];

export default function FimPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const all = useQuery({
    queryKey: ['admin', 'security', 'fim', 'all'],
    queryFn: () => list('/api/v1/admin/security/fim/changes'),
  });
  const open = (all.data ?? []).filter((e) => !e.acknowledged_at).length;
  const columns: ColumnDef<Change, unknown>[] = [
    {
      id: 'path',
      header: t('sec.fimPath'),
      accessorKey: 'path',
      cell: ({ row }) => <span className="font-mono wrap-anywhere">{row.original.path}</span>,
    },
    {
      id: 'change',
      header: t('sec.fimChange'),
      accessorKey: 'change',
      cell: ({ row }) => (
        <Badge tone={CHANGE_TONE[row.original.change]}>
          {t(`sec.fimChanges.${row.original.change}`)}
        </Badge>
      ),
    },
    {
      id: 'server',
      header: t('sec.server'),
      accessorFn: (c) => c.server.name,
    },
    {
      id: 'detected_at',
      header: t('sec.at'),
      accessorKey: 'detected_at',
      cell: ({ row }) => (
        <span className="whitespace-nowrap">{fmt.rel(row.original.detected_at)}</span>
      ),
    },
    {
      id: 'sha',
      header: t('sec.fimHash'),
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-sm text-muted">
          {(row.original.old_sha256 ?? '-').slice(0, 12)} →{' '}
          {(row.original.new_sha256 ?? '-').slice(0, 12)}
        </span>
      ),
    },
  ];
  const [rebase, setRebase] = useState(false);
  return (
    <>
      <ListPage<Change>
        actions={
          <Button variant="outline" onClick={() => setRebase(true)}>
            <Camera aria-hidden />
            {t('sec.fimRebaseline')}
          </Button>
        }
        title={t('sec.fimTitle')}
        description={t('sec.fimDescription')}
        nav={<SecurityNav current="fim" />}
        queryKey={['admin', 'security', 'fim', 'list']}
        fetch={(q) => list('/api/v1/admin/security/fim/changes', q)}
        columns={columns}
        getRowId={(e) => e.uuid}
        primaryColumnId="path"
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
      <RebaselineDialog open={rebase} onOpenChange={setRebase} />
    </>
  );
}

function RebaselineDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const servers = useQuery({
    queryKey: ['admin', 'servers', 'fim'],
    enabled: open,
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const [server, setServer] = useState('');
  const pick = server || servers.data?.[0]?.uuid || '';
  const go = useAction(
    (id: string) => send('POST', '/api/v1/admin/servers/{id}/fim:baseline', { path: { id } }),
    { invalidate: [['admin', 'security']], onSuccess: () => onOpenChange(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('sec.fimRebaselineTitle')}
      description={t('sec.fimRebaselineHint')}
      submitLabel={t('sec.fimRebaseline')}
      pending={go.isPending || !pick}
      onSubmit={() => go.mutate(pick)}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fim-server">{t('sec.server')}</Label>
        <Select
          id="fim-server"
          value={pick}
          onValueChange={setServer}
          options={(servers.data ?? []).map((x) => ({ value: x.uuid, label: x.name }))}
        />
      </div>
    </FormDialog>
  );
}
