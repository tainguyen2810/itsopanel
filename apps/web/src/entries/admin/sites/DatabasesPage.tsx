import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { useUrlState } from '@/shared/page/useUrlState';
import { StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Checkbox, Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { FormField } from '@/ui/FormField';
import { Label } from '@/ui/Label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/Tabs';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { Mono, RowMenu, SecretDialog, useAccountFilter, useActiveAccounts } from './common';
import { databaseSchema, dbUserSchema, type DatabaseForm, type DbUserForm } from './forms';

type Db = Row<'/api/v1/admin/databases'>;
type DbUser = Row<'/api/v1/admin/database-users'>;
const ENGINES = ['mariadb', 'mysql', 'postgresql'] as const;
const PRIVS = [
  'ALL',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
] as const;
type Priv = (typeof PRIVS)[number];

export default function DatabasesPage() {
  const { t } = useTranslation('admin');
  const [url, setUrl] = useUrlState();
  const tab = url.tab === 'users' ? 'users' : 'databases';
  return (
    <>
      <PageHeader title={t('dbs.title')} description={t('dbs.description')} />
      <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === 'users' ? 'users' : undefined })}>
        <TabsList>
          <TabsTrigger value="databases">{t('dbs.tabDatabases')}</TabsTrigger>
          <TabsTrigger value="users">{t('dbs.tabUsers')}</TabsTrigger>
        </TabsList>
        <TabsContent value="databases">
          <Databases />
        </TabsContent>
        <TabsContent value="users">
          <Users />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Databases() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const accountFilter = useAccountFilter();
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Db | null>(null);
  const exp = useAction((d: Db) =>
    send('POST', '/api/v1/admin/databases/{id}:export', { path: { id: d.uuid }, body: {} }),
  );
  const remove = useAction(
    (d: Db) => send('DELETE', '/api/v1/admin/databases/{id}', { path: { id: d.uuid } }),
    { onSuccess: () => setRemoving(null) },
  );
  const columns: ColumnDef<Db, unknown>[] = [
    {
      id: 'name',
      header: t('dbs.name'),
      accessorKey: 'name',
      cell: ({ row }) => <Mono>{row.original.name}</Mono>,
    },
    { id: 'account', header: t('sites.account'), accessorFn: (d) => d.hosting_account.username },
    { id: 'engine', header: t('dbs.engine'), accessorFn: (d) => t(`dbs.engines.${d.engine}`) },
    {
      id: 'size',
      header: t('sites.size'),
      accessorFn: (d) => d.size_mb,
      cell: ({ row }) => fmt.mb(row.original.size_mb),
    },
    { id: 'users', header: t('dbs.users'), accessorFn: (d) => d.users.join(', ') || '—' },
    {
      id: 'status',
      header: t('sites.status'),
      accessorKey: 'status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('dbs.actionsFor', { name: row.original.name })}
          actions={[
            { label: t('dbs.export'), onSelect: () => exp.mutate(row.original) },
            { label: t('dbs.delete'), onSelect: () => setRemoving(row.original), danger: true },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Db>
        embedded
        title={t('dbs.tabDatabases')}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('dbs.add')}
          </Button>
        }
        queryKey={['admin', 'databases']}
        fetch={(q) => list('/api/v1/admin/databases', q)}
        filters={[accountFilter]}
        columns={columns}
        getRowId={(d) => d.uuid}
        primaryColumnId="name"
      />
      <CreateDatabase open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('dbs.deleteTitle', { name: removing?.name ?? '' })}
        description={t('dbs.deleteHint')}
        confirmLabel={t('dbs.delete')}
        confirmName={removing?.name ?? ''}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function CreateDatabase({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const { accounts, options } = useActiveAccounts(open);
  const [accId, setAccId] = useState('');
  const prefix = accounts.find((a) => a.uuid === accId)?.username ?? '';
  const empty: DatabaseForm = {
    hosting_account_uuid: '',
    engine: 'mariadb',
    name: '',
    create_user: true,
  };
  const { control, handleSubmit, reset } = useForm<DatabaseForm>({
    resolver: zodResolver(databaseSchema(prefix)),
    defaultValues: empty,
  });
  const watched = useWatch({ control, name: 'hosting_account_uuid' });
  if (watched !== accId) setAccId(watched);
  const acc = accounts.find((a) => a.uuid === accId);
  const close = (o: boolean) => {
    if (!o) reset(empty);
    onOpenChange(o);
  };
  const create = useAction(
    (v: DatabaseForm) => send('POST', '/api/v1/admin/databases', { body: v }),
    { onSuccess: () => close(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t('dbs.addTitle')}
      description={t('dbs.addHint')}
      submitLabel={t('dbs.create')}
      pending={create.isPending}
      onSubmit={() => void handleSubmit((v) => create.mutate(v))()}
    >
      <SelectField
        control={control}
        name="hosting_account_uuid"
        label={t('sites.account')}
        options={options}
        placeholder={t('sites.pickAccount')}
        description={
          acc
            ? t('dbs.quota', { used: acc.usage.databases.used, limit: acc.usage.databases.limit })
            : undefined
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="engine"
          label={t('dbs.engine')}
          options={ENGINES.map((e) => ({ value: e, label: t(`dbs.engines.${e}`) }))}
        />
        <TextField
          control={control}
          name="name"
          label={t('dbs.name')}
          placeholder={prefix ? `${prefix}_app` : 'username_app'}
          description={prefix ? t('dbs.prefixHint', { prefix }) : undefined}
          autoComplete="off"
        />
      </div>
      <FormField
        control={control}
        name="create_user"
        label={t('dbs.createUser')}
        description={t('dbs.createUserHint')}
        render={(f) => (
          <Switch
            id={f.id}
            checked={f.value as boolean}
            onCheckedChange={f.onChange}
            aria-describedby={f['aria-describedby']}
          />
        )}
      />
    </FormDialog>
  );
}

function Users() {
  const { t } = useTranslation('admin');
  const accountFilter = useAccountFilter();
  const [creating, setCreating] = useState(false);
  const [granting, setGranting] = useState<DbUser | null>(null);
  const [removing, setRemoving] = useState<DbUser | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const rotate = useAction(
    (u: DbUser) =>
      send<{ secret: string }>('POST', '/api/v1/admin/database-users/{id}:rotate-password', {
        path: { id: u.uuid },
        body: {},
      }),
    { onSuccess: (r) => setSecret(r.secret) },
  );
  const remove = useAction(
    (u: DbUser) => send('DELETE', '/api/v1/admin/database-users/{id}', { path: { id: u.uuid } }),
    { onSuccess: () => setRemoving(null) },
  );
  const columns: ColumnDef<DbUser, unknown>[] = [
    {
      id: 'username',
      header: t('dbs.username'),
      accessorKey: 'username',
      cell: ({ row }) => <Mono>{row.original.username}</Mono>,
    },
    { id: 'account', header: t('sites.account'), accessorFn: (u) => u.hosting_account.username },
    { id: 'engine', header: t('dbs.engine'), accessorFn: (u) => t(`dbs.engines.${u.engine}`) },
    { id: 'host', header: 'Host', accessorKey: 'host' },
    {
      id: 'grants',
      header: t('dbs.grants'),
      accessorFn: (u) =>
        u.grants.map((g) => `${g.database}: ${g.privileges.join(', ')}`).join('; '),
      cell: ({ row }) =>
        row.original.grants.length === 0 ? (
          <span className="text-muted">{t('dbs.noGrants')}</span>
        ) : (
          <ul className="flex flex-col gap-0.5 text-sm">
            {row.original.grants.map((g) => (
              <li key={g.database}>
                <span className="font-mono">{g.database}</span>: {g.privileges.join(', ')}
              </li>
            ))}
          </ul>
        ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('dbs.actionsFor', { name: row.original.username })}
          actions={[
            { label: t('dbs.editGrants'), onSelect: () => setGranting(row.original) },
            { label: t('dbs.rotate'), onSelect: () => rotate.mutate(row.original) },
            { label: t('dbs.deleteUser'), onSelect: () => setRemoving(row.original), danger: true },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<DbUser>
        embedded
        title={t('dbs.tabUsers')}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('dbs.addUser')}
          </Button>
        }
        queryKey={['admin', 'database-users']}
        fetch={(q) => list('/api/v1/admin/database-users', q)}
        filters={[accountFilter]}
        columns={columns}
        getRowId={(u) => u.uuid}
        primaryColumnId="username"
      />
      <CreateUser open={creating} onOpenChange={setCreating} />
      {granting && <GrantsDialog user={granting} onClose={() => setGranting(null)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('dbs.deleteUserTitle', { name: removing?.username ?? '' })}
        description={t('dbs.deleteUserHint')}
        confirmLabel={t('dbs.deleteUser')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
      <SecretDialog secret={secret} title={t('dbs.newPassword')} onClose={() => setSecret(null)} />
    </>
  );
}

function CreateUser({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('admin');
  const { accounts, options } = useActiveAccounts(open);
  const [accId, setAccId] = useState('');
  const prefix = accounts.find((a) => a.uuid === accId)?.username ?? '';
  const empty: DbUserForm = {
    hosting_account_uuid: '',
    engine: 'mariadb',
    username: '',
    password: '',
  };
  const { control, handleSubmit, reset } = useForm<DbUserForm>({
    resolver: zodResolver(dbUserSchema(prefix)),
    defaultValues: empty,
  });
  const watched = useWatch({ control, name: 'hosting_account_uuid' });
  if (watched !== accId) setAccId(watched);
  const close = (o: boolean) => {
    if (!o) reset(empty);
    onOpenChange(o);
  };
  const create = useAction(
    (v: DbUserForm) =>
      send('POST', '/api/v1/admin/database-users', {
        body: {
          hosting_account_uuid: v.hosting_account_uuid,
          engine: v.engine,
          username: v.username,
          ...(v.password ? { password: v.password } : {}),
        },
      }),
    { onSuccess: () => close(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t('dbs.addUserTitle')}
      description={t('dbs.addUserHint')}
      submitLabel={t('dbs.create')}
      pending={create.isPending}
      onSubmit={() => void handleSubmit((v) => create.mutate(v))()}
    >
      <SelectField
        control={control}
        name="hosting_account_uuid"
        label={t('sites.account')}
        options={options}
        placeholder={t('sites.pickAccount')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="engine"
          label={t('dbs.engine')}
          options={ENGINES.map((e) => ({ value: e, label: t(`dbs.engines.${e}`) }))}
        />
        <TextField
          control={control}
          name="username"
          label={t('dbs.username')}
          placeholder={prefix ? `${prefix}_app` : 'username_app'}
          autoComplete="off"
        />
      </div>
      <TextField
        control={control}
        name="password"
        type="password"
        label={t('dbs.password')}
        description={t('dbs.passwordHint')}
        autoComplete="new-password"
        optional
      />
    </FormDialog>
  );
}

function GrantsDialog({ user, onClose }: { user: DbUser; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const [grants, setGrants] = useState<Record<string, Priv[]>>(
    Object.fromEntries(user.grants.map((g) => [g.database, g.privileges as Priv[]])),
  );
  const q = useQuery({
    queryKey: ['admin', 'databases', { filters: { hosting_account: user.hosting_account.uuid } }],
    queryFn: () =>
      list('/api/v1/admin/databases', { filters: { hosting_account: user.hosting_account.uuid } }),
  });
  // PostgreSQL và MariaDB/MySQL là hai máy chủ CSDL khác nhau: chỉ cấp quyền cùng loại.
  const pg = user.engine === 'postgresql';
  const dbs = q.data?.filter((d) => (d.engine === 'postgresql') === pg);
  const toggle = (db: string, p: Priv, on: boolean) =>
    setGrants((g) => {
      const cur = g[db] ?? [];
      const next = on
        ? p === 'ALL'
          ? ['ALL' as Priv]
          : [...cur.filter((x) => x !== 'ALL'), p]
        : cur.filter((x) => x !== p);
      return { ...g, [db]: next };
    });
  const save = useAction(
    () =>
      send('PUT', '/api/v1/admin/database-users/{id}/grants', {
        path: { id: user.uuid },
        body: {
          grants: Object.entries(grants)
            .filter(([, p]) => p.length > 0)
            .map(([database, privileges]) => ({ database, privileges })),
        },
      }),
    { onSuccess: onClose },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('dbs.grantsTitle', { name: user.username })}
      description={t('dbs.grantsHint')}
      pending={save.isPending}
      onSubmit={() => save.mutate()}
    >
      {(dbs ?? []).length === 0 && <p className="text-base text-muted">{t('dbs.noDatabases')}</p>}
      {(dbs ?? []).map((d) => (
        <fieldset key={d.uuid} className="flex flex-col gap-2 rounded-md border border-border p-3">
          <legend className="px-1 font-mono text-sm">{d.name}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {PRIVS.map((p) => {
              const id = `g-${d.uuid}-${p}`;
              return (
                <div key={p} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={(grants[d.name] ?? []).includes(p)}
                    onCheckedChange={(c) => toggle(d.name, p, c === true)}
                  />
                  <Label htmlFor={id} className="font-mono text-sm font-normal">
                    {p}
                  </Label>
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}
    </FormDialog>
  );
}
