import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BackupQuota } from '@/shared/hosting/pages/backup';
import { SnapshotsTab } from '@/shared/hosting/pages/SnapshotsTab';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { DetailPage } from '@/shared/page/DetailPage';
import { FormDialog } from '@/shared/page/FormDialog';
import { InfoList } from '@/shared/page/InfoList';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button, buttonVariants } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/DropdownMenu';
import { Input, Textarea } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { daysLeft, type Account } from './accounts';
import { UsageList, useAccount } from './common';

type Dialog = 'suspend' | 'unsuspend' | 'package' | 'terminate' | null;

export default function AccountDetailPage() {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const acc = useAccount();
  const [dialog, setDialog] = useState<Dialog>(null);

  if (acc.isPending) return <PageSkeleton />;
  if (acc.isError) {
    return (
      <>
        <PageHeader title={t('accounts.detail')} />
        <ErrorState error={acc.error} onRetry={() => void acc.refetch()} />
      </>
    );
  }
  const a = acc.data;
  const sa = user.role === 'SUPER_ADMIN';
  const s = a.lifecycle_state;
  const live = s !== 'terminated' && s !== 'purged';
  const close = (o: boolean) => !o && setDialog(null);
  return (
    <>
      <DetailPage
        title={a.username}
        meta={
          <>
            <StatusBadge status={s} />
            {a.legal_hold && <Badge tone="danger">{t('accounts.legalHold')}</Badge>}
          </>
        }
        description={`${a.owner.name} · ${a.server.name} · ${a.package.name} v${a.package.version}`}
        actions={
          live ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  {t('accounts.actions')}
                  <ChevronDown aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {s === 'active' && (
                  <DropdownMenuItem onSelect={() => setDialog('suspend')}>
                    {t('accounts.suspend')}
                  </DropdownMenuItem>
                )}
                {s === 'suspended' && (
                  <DropdownMenuItem onSelect={() => setDialog('unsuspend')}>
                    {t('accounts.unsuspend')}
                  </DropdownMenuItem>
                )}
                {(s === 'active' || s === 'suspended') && (
                  <DropdownMenuItem onSelect={() => setDialog('package')}>
                    {t('accounts.changePackage')}
                  </DropdownMenuItem>
                )}
                {(s === 'active' || s === 'migrating') && (
                  <DropdownMenuItem asChild>
                    <AppLink href={`/admin/hosting-accounts/${a.uuid}/migrate`}>
                      {t('accounts.migrate')}
                    </AppLink>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-danger-text"
                  onSelect={() => setDialog('terminate')}
                >
                  {t('accounts.terminate')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : sa ? (
            <AppLink
              href="/admin/hosting-accounts/terminated"
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('accounts.terminatedLink')}
            </AppLink>
          ) : undefined
        }
        tabs={[
          { value: 'overview', label: t('accounts.tabs.overview'), content: <Overview a={a} /> },
          {
            value: 'websites',
            label: t('accounts.tabs.websites'),
            content: <Websites id={a.uuid} />,
          },
          {
            value: 'databases',
            label: t('accounts.tabs.databases'),
            content: <Databases id={a.uuid} />,
          },
          { value: 'sftp', label: t('accounts.tabs.sftp'), content: <Sftp id={a.uuid} /> },
          { value: 'cron', label: t('accounts.tabs.cron'), content: <Cron id={a.uuid} /> },
          { value: 'backup', label: t('accounts.tabs.backup'), content: <Backups id={a.uuid} /> },
          {
            value: 'lifecycle',
            label: t('accounts.tabs.lifecycle'),
            content: <Lifecycle id={a.uuid} />,
          },
        ]}
      />
      <SuspendDialog a={a} open={dialog === 'suspend'} onOpenChange={close} />
      <UnsuspendDialog a={a} open={dialog === 'unsuspend'} onOpenChange={close} />
      <ChangePackageDialog a={a} open={dialog === 'package'} onOpenChange={close} />
      <TerminateDialog a={a} open={dialog === 'terminate'} onOpenChange={close} />
    </>
  );
}

const inv = (id: string) => [
  ['admin', 'account', id],
  ['admin', 'accounts'],
];

function Overview({ a }: { a: Account }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { user } = useSession();
  const hold = useAction(
    (v: boolean) =>
      send('PATCH', '/api/v1/admin/hosting-accounts/{id}', {
        path: { id: a.uuid },
        body: { legal_hold: v },
      }),
    { success: t('accounts.saved'), invalidate: inv(a.uuid) },
  );
  const left = daysLeft(a.purge_after);
  return (
    <div className="flex flex-col gap-4">
      {a.lifecycle_state === 'suspended' && (
        <Alert tone="warning" title={t('accounts.suspendedBanner')}>
          {a.suspended_reason}
        </Alert>
      )}
      {a.lifecycle_state === 'migrating' && (
        <Alert
          tone="info"
          title={t('accounts.migratingBanner')}
          action={
            <AppLink
              href={`/admin/hosting-accounts/${a.uuid}/migrate`}
              className={buttonVariants({ size: 'sm', variant: 'outline' })}
            >
              {t('accounts.openMigration')}
            </AppLink>
          }
        />
      )}
      {a.lifecycle_state === 'terminated' && (
        <Alert tone="danger" title={t('accounts.terminatedBanner', { count: left ?? 0 })}>
          {t('accounts.terminatedBannerHint', { date: fmt.opt(a.purge_after) })}
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title={t('accounts.usageTitle')}
            description={t('accounts.measuredAt', { time: fmt.rel(a.usage.measured_at) })}
          />
          <CardContent>
            <UsageList usage={a.usage} />
            <p className="mt-4 text-sm text-muted">
              {t('accounts.bandwidth', { value: fmt.mb(a.usage.bandwidth_mb_30d) })}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('accounts.info')} />
          <CardContent className="flex flex-col gap-4">
            <InfoList
              items={[
                [t('accounts.owner'), `${a.owner.name} · ${a.owner.email}`],
                [
                  t('accounts.server'),
                  <AppLink
                    key="s"
                    href={`/admin/servers/${a.server.uuid}`}
                    className="hover:underline"
                  >
                    {a.server.name}
                  </AppLink>,
                ],
                [
                  t('accounts.package'),
                  <AppLink
                    key="p"
                    href={`/admin/hosting-packages/${a.package.uuid}`}
                    className="hover:underline"
                  >
                    {a.package.name} v{a.package.version}
                  </AppLink>,
                ],
                ['UID', String(a.uid)],
                [
                  t('accounts.homePath'),
                  <span key="h" className="font-mono">
                    {a.home_path}
                  </span>,
                ],
                [
                  t('accounts.sync'),
                  <StatusBadge
                    key="v"
                    status={a.status}
                    desiredVersion={a.spec_version}
                    observedVersion={a.observed_version}
                  />,
                ],
                [t('accounts.createdAt'), fmt.dateTime(a.created_at)],
              ]}
            />
            {user.role === 'SUPER_ADMIN' && (
              <div className="flex flex-col gap-1 border-t border-border pt-4">
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="legal-hold">{t('accounts.legalHold')}</Label>
                  <Switch
                    id="legal-hold"
                    checked={a.legal_hold}
                    onCheckedChange={(v) => hold.mutate(v)}
                  />
                </div>
                <p className="text-sm text-muted">{t('accounts.legalHoldHint')}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SubList<T>({
  id,
  name,
  fetch,
  columns,
  rowId,
}: {
  id: string;
  name: string;
  fetch: () => Promise<T[]>;
  columns: ColumnDef<T, unknown>[];
  rowId: (r: T) => string;
}) {
  const { t } = useTranslation('admin');
  return (
    <ListPage<T>
      embedded
      search={false}
      title={t(`accounts.tabs.${name}` as never)}
      queryKey={['admin', 'account', id, name]}
      fetch={fetch}
      columns={columns}
      getRowId={rowId}
      empty={<p className="p-6 text-center text-base text-muted">{t('accounts.emptyTab')}</p>}
    />
  );
}

const byAccount = (id: string) => ({ filters: { hosting_account: id } });

function Websites({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  type W = Row<'/api/v1/admin/websites'>;
  return (
    <SubList<W>
      id={id}
      name="websites"
      fetch={() => list('/api/v1/admin/websites', byAccount(id))}
      rowId={(w) => w.uuid}
      columns={[
        {
          id: 'domain',
          header: t('accounts.domain'),
          accessorKey: 'primary_domain',
          cell: ({ row }) => (
            <AppLink
              href={`/admin/websites/${row.original.uuid}`}
              className="font-medium hover:underline"
            >
              {row.original.primary_domain}
            </AppLink>
          ),
        },
        { id: 'type', header: t('accounts.siteType'), accessorKey: 'type' },
        { id: 'php', header: 'PHP', accessorFn: (w) => w.php_version ?? '—' },
        {
          id: 'ssl',
          header: 'SSL',
          accessorFn: (w) => (w.certificate_expires_at ? fmt.date(w.certificate_expires_at) : '—'),
        },
        {
          id: 'status',
          header: t('accounts.state'),
          accessorKey: 'status',
          cell: ({ row }) => <StatusBadge status={row.original.status} />,
        },
      ]}
    />
  );
}

function Databases({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  type D = Row<'/api/v1/admin/databases'>;
  return (
    <SubList<D>
      id={id}
      name="databases"
      fetch={() => list('/api/v1/admin/databases', byAccount(id))}
      rowId={(d) => d.uuid}
      columns={[
        {
          id: 'name',
          header: t('accounts.dbName'),
          accessorKey: 'name',
          cell: ({ row }) => <span className="font-mono">{row.original.name}</span>,
        },
        { id: 'engine', header: t('accounts.engine'), accessorKey: 'engine' },
        { id: 'size', header: t('accounts.size'), accessorFn: (d) => fmt.mb(d.size_mb) },
        { id: 'users', header: t('accounts.dbUsers'), accessorFn: (d) => d.users.join(', ') },
        {
          id: 'status',
          header: t('accounts.state'),
          accessorKey: 'status',
          cell: ({ row }) => <StatusBadge status={row.original.status} />,
        },
      ]}
    />
  );
}

function Sftp({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  type S = Row<'/api/v1/admin/sftp-accounts'>;
  return (
    <SubList<S>
      id={id}
      name="sftp"
      fetch={() => list('/api/v1/admin/sftp-accounts', byAccount(id))}
      rowId={(s) => s.uuid}
      columns={[
        {
          id: 'username',
          header: t('accounts.username'),
          accessorKey: 'username',
          cell: ({ row }) => <span className="font-mono">{row.original.username}</span>,
        },
        {
          id: 'protocol',
          header: t('accounts.protocol'),
          accessorFn: (s) => s.protocol.toUpperCase(),
        },
        {
          id: 'root',
          header: t('accounts.rootPath'),
          accessorKey: 'root_path',
          cell: ({ row }) => <span className="font-mono text-sm">{row.original.root_path}</span>,
        },
        {
          id: 'mode',
          header: t('accounts.access'),
          accessorFn: (s) => (s.read_only ? t('accounts.readOnly') : t('accounts.readWrite')),
        },
        {
          id: 'last',
          header: t('accounts.lastLogin'),
          accessorFn: (s) => fmt.opt(s.last_login_at),
        },
      ]}
    />
  );
}

function Cron({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  type C = Row<'/api/v1/admin/cron-jobs'>;
  return (
    <SubList<C>
      id={id}
      name="cron"
      fetch={() => list('/api/v1/admin/cron-jobs', byAccount(id))}
      rowId={(c) => c.uuid}
      columns={[
        {
          id: 'schedule',
          header: t('accounts.schedule'),
          accessorKey: 'schedule',
          cell: ({ row }) => <span className="font-mono">{row.original.schedule}</span>,
        },
        {
          id: 'command',
          header: t('accounts.command'),
          accessorKey: 'command',
          cell: ({ row }) => <span className="font-mono text-sm">{row.original.command}</span>,
        },
        { id: 'last', header: t('accounts.lastRun'), accessorFn: (c) => fmt.opt(c.last_run_at) },
        {
          id: 'result',
          header: t('accounts.result'),
          accessorFn: (c) => (c.enabled ? (c.last_status ?? 'pending') : 'disabled'),
          cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
        },
      ]}
    />
  );
}

function Backups({ id }: { id: string }) {
  const navigate = useNavigate();
  return (
    <>
      <BackupQuota account={id} />
      <SnapshotsTab
        account={id}
        onRestore={(s) =>
          void navigate({ to: '/restores/new', search: { snapshot: s.uuid } } as never)
        }
      />
    </>
  );
}

function Lifecycle({ id }: { id: string }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'account', id, 'lifecycle'],
    queryFn: () =>
      list('/api/v1/admin/hosting-accounts/{id}/lifecycle-events', undefined, { path: { id } }),
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <Card>
      <CardHeader title={t('accounts.tabs.lifecycle')} description={t('accounts.lifecycleHint')} />
      <CardContent>
        <ol className="flex flex-col gap-4 border-l border-border pl-4">
          {(q.data ?? []).map((e) => (
            <li key={e.uuid} className="relative">
              <span
                aria-hidden
                className="absolute top-1.5 -left-[1.3rem] size-2.5 rounded-full border-2 border-surface bg-primary"
              />
              <div className="flex flex-wrap items-center gap-2">
                {e.from_state && (
                  <>
                    <StatusBadge status={e.from_state} />
                    <span aria-hidden className="text-muted">
                      →
                    </span>
                    <span className="sr-only">{t('accounts.to')}</span>
                  </>
                )}
                <StatusBadge status={e.to_state} />
                <time className="text-sm text-muted" dateTime={e.at}>
                  {fmt.dateTime(e.at)}
                </time>
              </div>
              <p className="mt-1 text-base">
                {e.reason ?? '—'}
                <span className="text-sm text-muted">
                  {' '}
                  · {e.actor ? e.actor.name : t('accounts.system')}
                </span>
                {e.job_uuid && (
                  <>
                    {' · '}
                    <AppLink href={`/admin/jobs/${e.job_uuid}`} className="text-sm hover:underline">
                      {t('accounts.viewJob')}
                    </AppLink>
                  </>
                )}
              </p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

interface DialogProps {
  a: Account;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}

function SuspendDialog({ a, open, onOpenChange }: DialogProps) {
  const { t } = useTranslation('admin');
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 5;
  const run = useAction(
    () =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:suspend', {
        path: { id: a.uuid },
        body: { reason: reason.trim() },
      }),
    { invalidate: inv(a.uuid), onSuccess: () => onOpenChange(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('accounts.suspendTitle', { name: a.username })}
      description={t('accounts.suspendHint')}
      submitLabel={t('accounts.suspend')}
      pending={run.isPending || !ok}
      onSubmit={() => ok && run.mutate()}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="suspend-reason">{t('accounts.reason')}</Label>
        <Textarea
          id="suspend-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby="suspend-reason-hint"
        />
        <p id="suspend-reason-hint" className="text-xs text-muted">
          {t('accounts.reasonHint')}
        </p>
      </div>
    </FormDialog>
  );
}

function UnsuspendDialog({ a, open, onOpenChange }: DialogProps) {
  const { t } = useTranslation('admin');
  const run = useAction(
    () =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:unsuspend', {
        path: { id: a.uuid },
        body: {},
      }),
    { invalidate: inv(a.uuid) },
  );
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      tone="primary"
      title={t('accounts.unsuspendTitle', { name: a.username })}
      description={t('accounts.unsuspendHint')}
      confirmLabel={t('accounts.unsuspend')}
      onConfirm={() => run.mutateAsync().then(() => undefined)}
    />
  );
}

function ChangePackageDialog({ a, open, onOpenChange }: DialogProps) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [pkg, setPkg] = useState(a.package.uuid);
  const packages = useQuery({
    queryKey: ['admin', 'packages', { q: '' }],
    queryFn: () => list('/api/v1/admin/hosting-packages'),
    enabled: open,
  });
  const p = packages.data?.find((x) => x.uuid === pkg);
  const same =
    p !== undefined && p.uuid === a.package.uuid && p.current_version === a.package.version;
  const run = useAction(
    () =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:change-package', {
        path: { id: a.uuid },
        body: { package_uuid: pkg, version: p?.current_version ?? null },
      }),
    { invalidate: inv(a.uuid), onSuccess: () => onOpenChange(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('accounts.changePackageTitle', { name: a.username })}
      description={t('accounts.changePackageHint', {
        current: `${a.package.name} v${a.package.version}`,
      })}
      submitLabel={t('accounts.changePackage')}
      pending={run.isPending || same || !p}
      onSubmit={() => run.mutate()}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-package">{t('accounts.newPackage')}</Label>
        <Select
          id="new-package"
          value={pkg}
          onValueChange={setPkg}
          options={(packages.data ?? [])
            .filter((x) => x.is_active)
            .map((x) => ({ value: x.uuid, label: `${x.name} v${x.current_version}` }))}
        />
      </div>
      {p && (
        <p className="text-sm text-muted">
          {fmt.mb(p.limits.disk_mb)} · {fmt.mb(p.limits.ram_mb)} RAM · CPU {p.limits.cpu_percent}% ·{' '}
          {t('accounts.sitesCount', { count: p.limits.website_limit })}
        </p>
      )}
      {same && <p className="text-sm text-muted">{t('accounts.samePackage')}</p>}
    </FormDialog>
  );
}

function TerminateDialog({ a, open, onOpenChange }: DialogProps) {
  const { t } = useTranslation('admin');
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const ok = reason.trim().length >= 5 && typed.trim() === a.username;
  const change = (o: boolean) => {
    if (!o) {
      setReason('');
      setTyped('');
    }
    onOpenChange(o);
  };
  const run = useAction(
    () =>
      send('POST', '/api/v1/admin/hosting-accounts/{id}:terminate', {
        path: { id: a.uuid },
        body: { reason: reason.trim(), confirm_username: typed.trim() },
      }),
    { invalidate: inv(a.uuid), onSuccess: () => change(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={change}
      title={t('accounts.terminateTitle', { name: a.username })}
      description={t('accounts.terminateHint')}
      submitLabel={t('accounts.terminate')}
      pending={run.isPending || !ok}
      onSubmit={() => ok && run.mutate()}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="term-reason">{t('accounts.reason')}</Label>
        <Textarea
          id="term-reason"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="term-confirm">{t('accounts.typeUsername', { name: a.username })}</Label>
        <Input
          id="term-confirm"
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          aria-invalid={typed !== '' && typed.trim() !== a.username}
        />
      </div>
    </FormDialog>
  );
}
