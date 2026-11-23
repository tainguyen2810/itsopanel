import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  Database,
  FileStack,
  Pencil,
  Play,
  Undo2,
  ArrowRightLeft,
  Trash2,
  HardDrive,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { FormDialog } from '@/shared/page/FormDialog';
import { PageHeader } from '@/shared/page/PageHeader';
import { Stepper } from '@/shared/page/Stepper';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { Badge, StatusBadge, type Tone } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Checkbox } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { StatCard } from '@/ui/StatCard';
import { get, list, send, type JobAccepted, type Row } from '../api';
import { useAction } from '../useAction';
import type { Import } from './ImportsPage';

type Item = Row<'/api/v1/admin/imports/{id}/items'>;
type Warning = Item['warnings'][number];

const STEP: Record<Import['state'], number> = {
  scanning: 0,
  scan_failed: 0,
  planned: 1,
  running: 2,
  completed: 3,
  partially_failed: 3,
  cut_over: 4,
  rolled_back: 4,
};
const WARN_TONE: Record<Warning['code'], Tone> = {
  php_missing: 'warning',
  ssl_expired: 'warning',
  domain_exists: 'danger',
  username_exists: 'danger',
  db_large: 'danger',
  quota_exceeded: 'warning',
  symlink_outside: 'warning',
  unsupported: 'danger',
};
const NEW_USER = '__new';

/**
 * Một lượt import (D-108): kế hoạch (chọn mục, map gói và USER), chạy theo account, báo cáo khác biệt
 * (file, bytes, bảng DB), cutover nginx và quay lại. Site ở panel nguồn vẫn chạy tới khi cutover.
 */
export default function ImportDetailPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const imp = useQuery({
    queryKey: ['admin', 'imports', id],
    queryFn: () => get('/api/v1/admin/imports/{id}', { path: { id } }),
    refetchInterval: (q) =>
      q.state.data?.state === 'scanning' || q.state.data?.state === 'running' ? 2000 : false,
  });
  const items = useQuery({
    queryKey: ['admin', 'imports', id, 'items'],
    queryFn: () => list('/api/v1/admin/imports/{id}/items', { filters: {} }, { path: { id } }),
    refetchInterval: imp.data?.state === 'running' || imp.data?.state === 'scanning' ? 2000 : false,
  });
  const [editing, setEditing] = useState<Item | null>(null);
  const [confirm, setConfirm] = useState<'run' | 'cutover' | 'rollback' | 'delete' | null>(null);
  const invalidate = [['admin', 'imports']];
  const act = useAction(
    (a: 'run' | 'cutover' | 'rollback') =>
      send<JobAccepted>('POST', `/api/v1/admin/imports/{id}:${a}` as never, { path: { id } }),
    { invalidate },
  );
  const del = useAction(() => send('DELETE', '/api/v1/admin/imports/{id}', { path: { id } }), {
    success: t('imports.deleted'),
    invalidate,
    onSuccess: () => void navigate({ to: '/imports' }),
  });

  if (imp.isLoading) return <PageSkeleton />;
  if (imp.error || !imp.data)
    return <ErrorState error={imp.error} onRetry={() => void imp.refetch()} />;
  const d = imp.data;
  const rows = items.data ?? [];
  const done = rows.filter((r) => r.result);
  const total = (k: 'files' | 'bytes' | 'skipped' | 'db_tables') =>
    done.reduce((n, r) => n + (r.result?.[k] ?? 0), 0);
  const steps = (['scan', 'plan', 'run', 'report', 'cutover'] as const).map((s) =>
    t(`imports.steps.${s}`),
  );
  const busy = d.state === 'scanning' || d.state === 'running';

  const columns: ColumnDef<Item, unknown>[] = [
    {
      id: 'domain',
      header: t('imports.site'),
      accessorKey: 'domain',
      cell: ({ row }) => {
        const it = row.original;
        return (
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-1.5 font-medium">
              {it.domain}
              {!it.selected && <Badge tone="neutral">{t('imports.notSelected')}</Badge>}
            </p>
            {it.aliases.length > 0 && <p className="text-sm text-muted">{it.aliases.join(', ')}</p>}
            <p className="font-mono text-xs wrap-anywhere text-muted">{it.docroot}</p>
          </div>
        );
      },
    },
    {
      id: 'stack',
      header: t('imports.stack'),
      enableSorting: false,
      cell: ({ row }) => {
        const it = row.original;
        return (
          <div className="flex flex-col items-start gap-1 text-sm">
            <span>{it.php_version ? `PHP ${it.php_version}` : t('imports.noPhp')}</span>
            <StatusBadge status={it.ssl === 'none' ? 'disabled' : it.ssl} />
            <span className="text-muted">
              {fmt.mb(it.size_mb)}
              {it.databases.length > 0 &&
                ` · ${it.databases.map((db) => `${db.name} (${fmt.mb(db.size_mb)})`).join(', ')}`}
              {it.crons > 0 && ` · ${t('imports.crons', { count: it.crons })}`}
            </span>
          </div>
        );
      },
    },
    {
      id: 'target',
      header: t('imports.target'),
      accessorFn: (it) => it.target.username,
      cell: ({ row }) => {
        const tg = row.original.target;
        return (
          <div className="text-sm">
            <p className="font-mono font-medium">{tg.username}</p>
            <p className="text-muted">
              {tg.package?.name ?? '—'} ·{' '}
              {tg.user?.name ??
                (tg.new_user ? t('imports.newUser', { name: tg.new_user.name }) : '—')}
            </p>
          </div>
        );
      },
    },
    {
      id: 'warnings',
      header: t('imports.warnings'),
      enableSorting: false,
      cell: ({ row }) =>
        row.original.warnings.length === 0 ? (
          <span className="text-sm text-muted">{t('imports.noWarnings')}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {row.original.warnings.map((w) => (
              <li key={w.code} className="flex flex-col items-start gap-0.5 text-sm">
                <Badge tone={WARN_TONE[w.code]}>{t(`imports.warn.${w.code}`)}</Badge>
                <span className="text-muted">{w.message}</span>
              </li>
            ))}
          </ul>
        ),
    },
    {
      id: 'state',
      header: t('sites.status'),
      accessorKey: 'state',
      cell: ({ row }) => {
        const it = row.original;
        const r = it.result;
        return (
          <div className="flex flex-col items-start gap-1 text-sm">
            <StatusBadge status={it.state} />
            {r && (
              <>
                <span className="text-muted">
                  {t('imports.resultLine', {
                    files: fmt.num(r.files),
                    size: fmt.bytes(r.bytes),
                    tables: r.db_tables,
                  })}
                </span>
                {r.skipped > 0 && (
                  <span className="text-warning-text">
                    {t('imports.skipped', { count: r.skipped })}: {r.skipped_reasons.join('; ')}
                  </span>
                )}
                {r.certificate && (
                  <span className="text-muted">{t(`imports.cert.${r.certificate}`)}</span>
                )}
                {r.error && <span className="wrap-anywhere text-danger-text">{r.error}</span>}
              </>
            )}
          </div>
        );
      },
    },
  ];
  if (d.state === 'planned')
    columns.push({
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setEditing(row.original)}
          aria-label={t('imports.editFor', { domain: row.original.domain })}
        >
          <Pencil aria-hidden />
          {t('imports.edit')}
        </Button>
      ),
    });

  return (
    <>
      <PageHeader
        crumb={`${t(`imports.sources.${d.source}`)} · ${d.server.name}`}
        title={t('imports.detailTitle', {
          source: t(`imports.sources.${d.source}`),
          server: d.server.name,
        })}
        description={d.source_version ?? undefined}
        meta={<StatusBadge status={d.state} />}
        actions={
          <div className="flex flex-wrap gap-2">
            {d.state === 'planned' && (
              <Button onClick={() => setConfirm('run')} disabled={d.summary.selected === 0}>
                <Play aria-hidden />
                {t('imports.run')}
              </Button>
            )}
            {(d.state === 'completed' || d.state === 'partially_failed') && (
              <Button onClick={() => setConfirm('cutover')}>
                <ArrowRightLeft aria-hidden />
                {t('imports.cutover')}
              </Button>
            )}
            {d.state === 'cut_over' && (
              <Button variant="outline" onClick={() => setConfirm('rollback')}>
                <Undo2 aria-hidden />
                {t('imports.rollback')}
              </Button>
            )}
            {!busy && (
              <Button variant="outline" onClick={() => setConfirm('delete')}>
                <Trash2 aria-hidden />
                {t('imports.delete')}
              </Button>
            )}
          </div>
        }
      />
      <Stepper steps={steps} current={STEP[d.state]} label={t('imports.stepsLabel')} />
      <div className="flex flex-col gap-4">
        {d.state === 'scanning' && <Alert tone="info" title={t('imports.alert.scanning')} />}
        {d.state === 'scan_failed' && (
          <Alert tone="danger" title={t('imports.alert.scanFailed')}>
            {d.error}
          </Alert>
        )}
        {d.state === 'planned' && (
          <Alert tone="info" title={t('imports.alert.planned')}>
            {t('imports.alert.plannedHint')}
          </Alert>
        )}
        {d.state === 'running' && <Alert tone="info" title={t('imports.alert.running')} />}
        {d.state === 'partially_failed' && (
          <Alert tone="warning" title={t('imports.alert.partial')}>
            {t('imports.alert.partialHint')}
          </Alert>
        )}
        {d.state === 'completed' && (
          <Alert tone="success" title={t('imports.alert.completed')}>
            {t('imports.alert.completedHint')}
          </Alert>
        )}
        {d.state === 'cut_over' && d.cutover_at && (
          <Alert
            tone="success"
            title={t('imports.alert.cutOver', { at: fmt.dateTime(d.cutover_at) })}
          >
            {t('imports.alert.cutOverHint')}
          </Alert>
        )}
        {d.state === 'rolled_back' && <Alert tone="info" title={t('imports.alert.rolledBack')} />}
        {done.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              icon={FileStack}
              label={t('imports.totFiles')}
              value={fmt.num(total('files'))}
            />
            <StatCard
              icon={HardDrive}
              label={t('imports.totBytes')}
              value={fmt.bytes(total('bytes'))}
            />
            <StatCard
              icon={Database}
              label={t('imports.totTables')}
              value={fmt.num(total('db_tables'))}
            />
            <StatCard
              icon={FileStack}
              tone={total('skipped') > 0 ? 'warning' : 'success'}
              label={t('imports.totSkipped')}
              value={fmt.num(total('skipped'))}
              hint={t('imports.totSkippedHint')}
            />
          </div>
        )}
        <Card>
          <CardHeader
            title={done.length > 0 ? t('imports.reportTitle') : t('imports.planTitle')}
            description={t('imports.planHint', {
              sites: d.summary.sites,
              selected: d.summary.selected,
            })}
          />
          <CardContent>
            <DataTable<Item>
              data={rows}
              columns={columns}
              getRowId={(r) => r.uuid}
              primaryColumnId="domain"
              caption={t('imports.planTitle')}
              empty={t('imports.noItems')}
            />
          </CardContent>
        </Card>
      </div>
      {editing && <EditItemDialog importId={id} item={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={confirm === 'run' || confirm === 'cutover' || confirm === 'rollback'}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="primary"
        title={confirm ? t(`imports.confirm.${confirm}Title` as never) : ''}
        description={confirm ? t(`imports.confirm.${confirm}Hint` as never) : ''}
        confirmLabel={confirm ? t(`imports.${confirm}` as never) : ''}
        onConfirm={async () => {
          if (confirm === 'run' || confirm === 'cutover' || confirm === 'rollback')
            await act.mutateAsync(confirm);
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('imports.confirm.deleteTitle')}
        description={t('imports.confirm.deleteHint')}
        confirmLabel={t('imports.delete')}
        onConfirm={async () => {
          await del.mutateAsync();
          setConfirm(null);
        }}
      />
    </>
  );
}

function EditItemDialog({
  importId,
  item,
  onClose,
}: {
  importId: string;
  item: Item;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const packages = useQuery({
    queryKey: ['admin', 'packages', 'imports'],
    queryFn: () => list('/api/v1/admin/hosting-packages'),
  });
  const users = useQuery({
    queryKey: ['admin', 'users', 'imports'],
    queryFn: () => list('/api/v1/admin/users'),
  });
  const [selected, setSelected] = useState(item.selected);
  const [username, setUsername] = useState(item.target.username);
  const [pkg, setPkg] = useState(item.target.package?.uuid ?? '');
  const [owner, setOwner] = useState(
    item.target.user?.uuid ?? (item.target.new_user ? NEW_USER : ''),
  );
  const [name, setName] = useState(item.target.new_user?.name ?? '');
  const [email, setEmail] = useState(item.target.new_user?.email ?? '');
  const save = useAction(
    () =>
      send('PUT', '/api/v1/admin/imports/{id}/plan', {
        path: { id: importId },
        body: {
          items: [
            {
              uuid: item.uuid,
              selected,
              username,
              package: pkg || (packages.data?.[0]?.uuid ?? ''),
              user: owner === NEW_USER ? null : owner || null,
              new_user: owner === NEW_USER ? { name, email } : null,
            },
          ],
        },
      }),
    { success: t('imports.saved'), invalidate: [['admin', 'imports']], onSuccess: onClose },
  );
  const portalUsers = (users.data ?? []).filter((u) => u.role === 'USER');
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('imports.editTitle', { domain: item.domain })}
      description={t('imports.editHint')}
      pending={save.isPending}
      onSubmit={() => save.mutate()}
    >
      <div className="flex items-center gap-2">
        <Checkbox
          id="imp-selected"
          checked={selected}
          onCheckedChange={(v) => setSelected(v === true)}
        />
        <Label htmlFor="imp-selected">{t('imports.selectItem')}</Label>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="imp-username">{t('imports.username')}</Label>
        <Input
          id="imp-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="font-mono"
          autoComplete="off"
        />
        <p className="text-sm text-muted">{t('imports.usernameHint')}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="imp-package">{t('imports.package')}</Label>
        <Select
          id="imp-package"
          value={pkg}
          onValueChange={setPkg}
          options={(packages.data ?? []).map((p) => ({ value: p.uuid, label: p.name }))}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="imp-owner">{t('imports.owner')}</Label>
        <Select
          id="imp-owner"
          value={owner}
          onValueChange={setOwner}
          options={[
            ...portalUsers.map((u) => ({ value: u.uuid, label: `${u.name} (${u.email})` })),
            { value: NEW_USER, label: t('imports.createUser') },
          ]}
        />
      </div>
      {owner === NEW_USER && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="imp-new-name">{t('imports.newUserName')}</Label>
            <Input id="imp-new-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="imp-new-email">{t('imports.newUserEmail')}</Label>
            <Input
              id="imp-new-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>
      )}
    </FormDialog>
  );
}
