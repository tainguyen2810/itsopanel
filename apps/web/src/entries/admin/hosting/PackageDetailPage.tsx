import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRight, Pencil, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { DetailPage } from '@/shared/page/DetailPage';
import { InfoList } from '@/shared/page/InfoList';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { LIMIT_KEYS, useLimitText, usePackage } from './common';
import { PackageForm } from './PackageForm';
import { diffLimits, type Limits, type Package, type PackageForm as Form } from './packages';

type Version = Row<'/api/v1/admin/hosting-packages/{id}/versions'>;
type Account = Row<'/api/v1/admin/hosting-accounts'>;

export default function PackageDetailPage() {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const pkg = usePackage();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inv = [
    ['admin', 'package', pkg.id],
    ['admin', 'packages'],
  ];
  const save = useAction(
    (v: Partial<Form> & { is_active?: boolean }) =>
      send<Package>('PATCH', '/api/v1/admin/hosting-packages/{id}', {
        path: { id: pkg.id },
        body: v,
      }),
    { success: t('packages.saved'), invalidate: inv, onSuccess: () => setEditing(false) },
  );
  const remove = useAction(
    () => send('DELETE', '/api/v1/admin/hosting-packages/{id}', { path: { id: pkg.id } }),
    {
      success: t('packages.deleted'),
      invalidate: [['admin', 'packages']],
      onSuccess: () => void navigate({ to: '/hosting-packages' }),
    },
  );

  if (pkg.isPending) return <PageSkeleton />;
  if (pkg.isError) {
    return (
      <>
        <PageHeader title={t('packages.detail')} />
        <ErrorState error={pkg.error} onRetry={() => void pkg.refetch()} />
      </>
    );
  }
  const p = pkg.data;
  if (editing) {
    return (
      <>
        <PageHeader title={t('packages.editTitle', { name: p.name })} crumb={p.name} />
        <PackageForm
          defaultValues={{
            code: p.code,
            name: p.name,
            description: p.description ?? '',
            limits: p.limits as Form['limits'],
          }}
          editing={{ version: p.current_version, accounts: p.account_count }}
          pending={save.isPending}
          submitLabel={t('packages.save')}
          onSubmit={({ name, description, limits }) =>
            save.mutate({ name, description: description || null, limits } as never)
          }
          onCancel={() => setEditing(false)}
        />
      </>
    );
  }
  return (
    <>
      <DetailPage
        title={p.name}
        meta={
          <>
            <Badge tone="neutral">v{p.current_version}</Badge>
            <StatusBadge status={p.is_active ? 'active' : 'disabled'} />
          </>
        }
        description={p.description ?? undefined}
        actions={
          <>
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil aria-hidden />
              {t('packages.edit')}
            </Button>
            <Button variant="outline" onClick={() => setDeleting(true)}>
              <Trash2 aria-hidden />
              {t('packages.delete')}
            </Button>
          </>
        }
        tabs={[
          {
            value: 'limits',
            label: t('packages.tabs.limits'),
            content: <LimitsTab p={p} onActive={(is_active) => save.mutate({ is_active })} />,
          },
          { value: 'versions', label: t('packages.tabs.versions'), content: <Versions p={p} /> },
          { value: 'compare', label: t('packages.tabs.compare'), content: <Compare p={p} /> },
          { value: 'accounts', label: t('packages.tabs.accounts'), content: <Accounts p={p} /> },
        ]}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('packages.deleteTitle', { name: p.name })}
        description={
          p.account_count > 0
            ? t('packages.deleteBlocked', { count: p.account_count })
            : t('packages.deleteHint')
        }
        confirmName={p.code}
        confirmLabel={t('packages.delete')}
        onConfirm={() => remove.mutateAsync().then(() => undefined)}
      />
    </>
  );
}

function LimitsTab({ p, onActive }: { p: Package; onActive: (v: boolean) => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const text = useLimitText();
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader
          title={t('packages.currentLimits', { version: p.current_version })}
          description={t('packages.currentLimitsHint')}
        />
        <CardContent>
          <InfoList items={LIMIT_KEYS.map((k) => [t(`packages.limits.${k}`), text(k, p.limits)])} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader title={t('packages.info')} />
        <CardContent className="flex flex-col gap-4">
          <InfoList
            items={[
              [
                t('packages.code'),
                <span key="c" className="font-mono">
                  {p.code}
                </span>,
              ],
              [t('packages.accounts'), fmt.num(p.account_count)],
              [t('packages.createdAt'), fmt.dateTime(p.created_at)],
              [t('packages.updatedAt'), fmt.dateTime(p.updated_at)],
            ]}
          />
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="pkg-active">{t('packages.onSale')}</Label>
            <Switch id="pkg-active" checked={p.is_active} onCheckedChange={onActive} />
          </div>
          <p className="text-sm text-muted">{t('packages.onSaleHint')}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function useVersions(id: string) {
  return useQuery({
    queryKey: ['admin', 'package', id, 'versions'],
    queryFn: () =>
      list('/api/v1/admin/hosting-packages/{id}/versions', undefined, { path: { id } }),
  });
}

function Versions({ p }: { p: Package }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [target, setTarget] = useState<Version | null>(null);
  const migrate = useAction(
    (v: number) =>
      send('POST', '/api/v1/admin/hosting-packages/{id}/versions/{version}:migrate-accounts', {
        path: { id: p.uuid, version: String(v) },
        body: {},
      }),
    {},
  );
  const outdated = (v: Version) => p.account_count - v.account_count;
  const columns: ColumnDef<Version, unknown>[] = [
    {
      id: 'version',
      header: t('packages.version'),
      accessorKey: 'version',
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <Badge tone={row.original.version === p.current_version ? 'primary' : 'neutral'}>
            v{row.original.version}
          </Badge>
          {row.original.version === p.current_version && (
            <span className="text-sm text-muted">{t('packages.current')}</span>
          )}
        </span>
      ),
    },
    {
      id: 'accounts',
      header: t('packages.accounts'),
      accessorKey: 'account_count',
      cell: ({ row }) => (
        <span className="tabular-nums">{fmt.num(row.original.account_count)}</span>
      ),
    },
    { id: 'by', header: t('packages.createdBy'), accessorFn: (v) => v.created_by.name },
    { id: 'at', header: t('packages.createdAt'), accessorFn: (v) => fmt.dateTime(v.created_at) },
    {
      id: 'actions',
      header: t('packages.actions'),
      enableSorting: false,
      cell: ({ row }) =>
        row.original.version === p.current_version && outdated(row.original) > 0 ? (
          <Button size="sm" variant="outline" onClick={() => setTarget(row.original)}>
            <ArrowRight aria-hidden />
            {t('packages.migrateTo', { version: row.original.version })}
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <ListPage<Version>
        embedded
        search={false}
        title={t('packages.tabs.versions')}
        queryKey={['admin', 'package', p.uuid, 'versions']}
        fetch={() =>
          list('/api/v1/admin/hosting-packages/{id}/versions', undefined, { path: { id: p.uuid } })
        }
        columns={columns}
        getRowId={(v) => v.uuid}
        primaryColumnId="version"
      />
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        tone="primary"
        title={t('packages.migrateTitle', { version: target?.version ?? 0 })}
        description={t('packages.migrateHint', { count: target ? outdated(target) : 0 })}
        confirmLabel={t('packages.migrateConfirm')}
        onConfirm={() =>
          migrate.mutateAsync(target?.version ?? p.current_version).then(() => setTarget(null))
        }
      />
    </>
  );
}

function Compare({ p }: { p: Package }) {
  const { t } = useTranslation('admin');
  const text = useLimitText();
  const versions = useVersions(p.uuid);
  const all = [...(versions.data ?? [])].sort((a, b) => a.version - b.version);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  if (versions.isError) {
    return <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />;
  }
  const a = all.find((v) => String(v.version) === from) ?? all.at(-2) ?? all[0];
  const b = all.find((v) => String(v.version) === to) ?? all.at(-1);
  const opts = all.map((v) => ({ value: String(v.version), label: `v${v.version}` }));
  const changes = a && b ? diffLimits(a.limits, b.limits) : [];
  return (
    <Card>
      <CardHeader
        title={t('packages.compareTitle')}
        description={t('packages.compareHint')}
        action={
          <div className="flex items-center gap-2">
            <Select
              aria-label={t('packages.compareFrom')}
              className="w-24"
              value={a ? String(a.version) : undefined}
              onValueChange={setFrom}
              options={opts}
            />
            <ArrowRight aria-hidden className="size-4 text-muted" />
            <Select
              aria-label={t('packages.compareTo')}
              className="w-24"
              value={b ? String(b.version) : undefined}
              onValueChange={setTo}
              options={opts}
            />
          </div>
        }
      />
      <CardContent>
        {all.length < 2 ? (
          <p className="text-base text-muted">{t('packages.compareSingle')}</p>
        ) : !a || !b ? null : (
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <caption className="sr-only">{t('packages.compareTitle')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-sm text-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('packages.limit')}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    v{a.version}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    v{b.version}
                  </th>
                </tr>
              </thead>
              <tbody>
                {LIMIT_KEYS.map((k) => {
                  const changed = changes.some((c) => c.key === k);
                  return (
                    <tr key={k} className="border-b border-border last:border-0">
                      <th scope="row" className="py-2 pr-4 text-left font-normal text-muted">
                        {t(`packages.limits.${k}`)}
                      </th>
                      <td className="py-2 pr-4 tabular-nums">{text(k, a.limits as Limits)}</td>
                      <td
                        className={
                          changed
                            ? 'py-2 font-medium text-primary-text tabular-nums'
                            : 'py-2 tabular-nums'
                        }
                      >
                        {text(k, b.limits as Limits)}
                        {changed && <span className="sr-only"> ({t('packages.changed')})</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-sm text-muted">
              {t('packages.changedCount', { count: changes.length })}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Accounts({ p }: { p: Package }) {
  const { t } = useTranslation('admin');
  const columns: ColumnDef<Account, unknown>[] = [
    {
      id: 'username',
      header: t('accounts.username'),
      accessorKey: 'username',
      cell: ({ row }) => (
        <AppLink
          href={`/admin/hosting-accounts/${row.original.uuid}`}
          className="font-medium hover:underline"
        >
          {row.original.username}
        </AppLink>
      ),
    },
    { id: 'owner', header: t('accounts.owner'), accessorFn: (a) => a.owner.name },
    { id: 'server', header: t('accounts.server'), accessorFn: (a) => a.server.name },
    {
      id: 'version',
      header: t('packages.version'),
      accessorFn: (a) => a.package.version,
      cell: ({ getValue }) => (
        <Badge tone={getValue<number>() === p.current_version ? 'neutral' : 'warning'}>
          v{getValue<number>()}
        </Badge>
      ),
    },
    {
      id: 'state',
      header: t('accounts.state'),
      accessorKey: 'lifecycle_state',
      cell: ({ row }) => <StatusBadge status={row.original.lifecycle_state} />,
    },
  ];
  return (
    <ListPage<Account>
      embedded
      title={t('packages.tabs.accounts')}
      queryKey={['admin', 'package', p.uuid, 'accounts']}
      fetch={async (q) =>
        (await list('/api/v1/admin/hosting-accounts', q)).filter(
          (a) => a.package.uuid === p.uuid && a.lifecycle_state !== 'purged',
        )
      }
      columns={columns}
      getRowId={(a) => a.uuid}
      primaryColumnId="username"
    />
  );
}
