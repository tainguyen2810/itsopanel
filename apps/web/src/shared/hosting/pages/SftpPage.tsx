import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { useUrlState } from '@/shared/page/useUrlState';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { FormField } from '@/ui/FormField';
import { Textarea } from '@/ui/Input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/Tabs';
import { list, send, type Row } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { Mono, RowMenu, useAccountFilter, useActiveAccounts } from './common';
import { sftpSchema, sshKeySchema, type SftpForm, type SshKeyForm } from './forms';

type Sftp = Row<'/sftp-accounts'>;
type Key = Row<'/ssh-keys'>;

export default function SftpPage() {
  const { t } = useTranslation('admin');
  const [url, setUrl] = useUrlState();
  const tab = url.tab === 'keys' ? 'keys' : 'sftp';
  return (
    <>
      <PageHeader title={t('sftp.title')} description={t('sftp.description')} />
      <Tabs value={tab} onValueChange={(v) => setUrl({ tab: v === 'keys' ? 'keys' : undefined })}>
        <TabsList>
          <TabsTrigger value="sftp">{t('sftp.tabAccounts')}</TabsTrigger>
          <TabsTrigger value="keys">{t('sftp.tabKeys')}</TabsTrigger>
        </TabsList>
        <TabsContent value="sftp">
          <Accounts />
        </TabsContent>
        <TabsContent value="keys">
          <Keys />
        </TabsContent>
      </Tabs>
    </>
  );
}

function Accounts() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const accountFilter = useAccountFilter();
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Sftp | null>(null);
  const remove = useAction(
    (s: Sftp) => send('DELETE', '/sftp-accounts/{id}', { path: { id: s.uuid } }),
    { onSuccess: () => setRemoving(null) },
  );
  const columns: ColumnDef<Sftp, unknown>[] = [
    {
      id: 'username',
      header: t('sftp.username'),
      accessorKey: 'username',
      cell: ({ row }) => <Mono>{row.original.username}</Mono>,
    },
    { id: 'account', header: t('sites.account'), accessorFn: (s) => s.hosting_account.username },
    { id: 'protocol', header: t('sftp.protocol'), accessorFn: (s) => s.protocol.toUpperCase() },
    {
      id: 'root',
      header: t('sftp.root'),
      accessorKey: 'root_path',
      cell: ({ row }) => (
        <Mono>~/{row.original.root_path === '.' ? '' : row.original.root_path}</Mono>
      ),
    },
    {
      id: 'access',
      header: t('sftp.access'),
      accessorFn: (s) => (s.read_only ? 1 : 0),
      cell: ({ row }) =>
        row.original.read_only ? (
          <Badge tone="neutral">{t('sftp.readOnly')}</Badge>
        ) : (
          <Badge tone="info">{t('sftp.readWrite')}</Badge>
        ),
    },
    { id: 'last', header: t('sftp.lastLogin'), accessorFn: (s) => fmt.opt(s.last_login_at) },
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
          label={t('sftp.actionsFor', { name: row.original.username })}
          actions={[
            { label: t('sftp.delete'), onSelect: () => setRemoving(row.original), danger: true },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Sftp>
        embedded
        title={t('sftp.tabAccounts')}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('sftp.add')}
          </Button>
        }
        queryKey={['admin', 'sftp']}
        fetch={(q) => list('/sftp-accounts', q)}
        filters={[accountFilter]}
        columns={columns}
        getRowId={(s) => s.uuid}
        primaryColumnId="username"
      />
      <CreateSftp open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('sftp.deleteTitle', { name: removing?.username ?? '' })}
        description={t('sftp.deleteHint')}
        confirmLabel={t('sftp.delete')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function CreateSftp({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('admin');
  const { accounts, options } = useActiveAccounts(open);
  const [accId, setAccId] = useState('');
  const acc = accounts.find((a) => a.uuid === accId);
  const empty: SftpForm = {
    hosting_account_uuid: '',
    username: '',
    protocol: 'sftp',
    root_path: '.',
    read_only: false,
  };
  const { control, handleSubmit, reset } = useForm<SftpForm>({
    resolver: zodResolver(sftpSchema(acc?.username ?? '')),
    defaultValues: empty,
  });
  const watched = useWatch({ control, name: 'hosting_account_uuid' });
  if (watched !== accId) setAccId(watched);
  const close = (o: boolean) => {
    if (!o) reset(empty);
    onOpenChange(o);
  };
  const create = useAction(
    (v: SftpForm) => send('POST', '/sftp-accounts', { body: { ...v, password: null } }),
    { onSuccess: () => close(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t('sftp.addTitle')}
      description={t('sftp.addHint')}
      submitLabel={t('sftp.create')}
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
            ? t('sftp.quota', {
                used: acc.usage.ftp_accounts.used,
                limit: acc.usage.ftp_accounts.limit,
              })
            : undefined
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          control={control}
          name="username"
          label={t('sftp.username')}
          placeholder={acc ? `${acc.username}_dev` : 'username_dev'}
          autoComplete="off"
        />
        <SelectField
          control={control}
          name="protocol"
          label={t('sftp.protocol')}
          options={[
            { value: 'sftp', label: 'SFTP' },
            { value: 'ftps', label: 'FTPS' },
          ]}
        />
      </div>
      <TextField
        control={control}
        name="root_path"
        label={t('sftp.root')}
        description={t('sftp.rootHint', { home: acc?.home_path ?? '~' })}
      />
      <FormField
        control={control}
        name="read_only"
        label={t('sftp.readOnly')}
        description={t('sftp.readOnlyHint')}
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

function Keys() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const accountFilter = useAccountFilter();
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Key | null>(null);
  const remove = useAction((k: Key) => send('DELETE', '/ssh-keys/{id}', { path: { id: k.uuid } }), {
    onSuccess: () => setRemoving(null),
  });
  const columns: ColumnDef<Key, unknown>[] = [
    {
      id: 'name',
      header: t('sftp.keyName'),
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    { id: 'account', header: t('sites.account'), accessorFn: (k) => k.hosting_account.username },
    { id: 'type', header: t('sftp.keyType'), accessorKey: 'type' },
    {
      id: 'fp',
      header: t('sftp.fingerprint'),
      accessorKey: 'fingerprint',
      cell: ({ row }) => <Mono>{row.original.fingerprint}</Mono>,
    },
    { id: 'used', header: t('sftp.lastUsed'), accessorFn: (k) => fmt.opt(k.last_used_at) },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('sftp.actionsFor', { name: row.original.name })}
          actions={[
            { label: t('sftp.removeKey'), onSelect: () => setRemoving(row.original), danger: true },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Key>
        embedded
        title={t('sftp.tabKeys')}
        description={t('sftp.keysHint')}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('sftp.addKey')}
          </Button>
        }
        queryKey={['admin', 'ssh-keys']}
        fetch={(q) => list('/ssh-keys', q)}
        filters={[accountFilter]}
        columns={columns}
        getRowId={(k) => k.uuid}
        primaryColumnId="name"
      />
      <AddKey open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('sftp.removeKeyTitle', { name: removing?.name ?? '' })}
        description={t('sftp.removeKeyHint')}
        confirmLabel={t('sftp.removeKey')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function AddKey({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('admin');
  const { options } = useActiveAccounts(open);
  const empty: SshKeyForm = { hosting_account_uuid: '', name: '', public_key: '' };
  const { control, handleSubmit, reset } = useForm<SshKeyForm>({
    resolver: zodResolver(sshKeySchema),
    defaultValues: empty,
  });
  const close = (o: boolean) => {
    if (!o) reset(empty);
    onOpenChange(o);
  };
  const add = useAction((v: SshKeyForm) => send('POST', '/ssh-keys', { body: v }), {
    onSuccess: () => close(false),
  });
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t('sftp.addKeyTitle')}
      description={t('sftp.addKeyHint')}
      submitLabel={t('sftp.addKey')}
      pending={add.isPending}
      onSubmit={() => void handleSubmit((v) => add.mutate(v))()}
    >
      <SelectField
        control={control}
        name="hosting_account_uuid"
        label={t('sites.account')}
        options={options}
        placeholder={t('sites.pickAccount')}
      />
      <TextField control={control} name="name" label={t('sftp.keyName')} placeholder="laptop-bao" />
      <FormField
        control={control}
        name="public_key"
        label={t('sftp.publicKey')}
        description={t('sftp.publicKeyHint')}
        render={(f) => (
          <Textarea
            {...f}
            rows={4}
            className="font-mono text-sm"
            spellCheck={false}
            value={String(f.value ?? '')}
          />
        )}
      />
    </FormDialog>
  );
}
