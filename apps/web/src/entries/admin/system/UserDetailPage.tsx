import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { DetailPage } from '@/shared/page/DetailPage';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { InfoList } from '@/shared/page/InfoList';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { AppLink } from '@/ui/AppLink';
import { Alert } from '@/ui/Alert';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Checkbox } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { get, list, send, type Row } from '../api';
import { auditLabel, resourceHref } from '../labels';
import { useAction } from '../useAction';
import { ImpersonateDialog, useUserPolicy, type User } from './users';

type Audit = Row<'/api/v1/admin/audit-logs'>;
type Scope = Row<'/api/v1/admin/users/{id}/scopes'>;
type Act = 'lock' | 'unlock' | 'reset-mfa';

const editSchema = z.object({
  name: z.string().trim().min(1, 'form.required').max(120, 'form.maxLength|120'),
  email: z.email('form.email'),
  locale: z.enum(['vi', 'en']),
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'USER']),
});
type EditForm = z.infer<typeof editSchema>;

export default function UserDetailPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { id } = useParams({ strict: false }) as { id: string };
  const policy = useUserPolicy();
  const [editing, setEditing] = useState(false);
  const [imp, setImp] = useState<User | null>(null);
  const [confirm, setConfirm] = useState<Act | null>(null);
  const q = useQuery({
    queryKey: ['admin', 'users', id],
    queryFn: () => get('/api/v1/admin/users/{id}', { path: { id } }),
  });
  const act = useAction(
    (a: Act) =>
      send('POST', `/api/v1/admin/users/{id}:${a}` as '/api/v1/admin/users/{id}:lock', {
        path: { id },
      }),
    { invalidate: [['admin', 'users']], onSuccess: () => setConfirm(null) },
  );
  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const u = q.data;
  const self = u.uuid === policy.me.uuid;
  const manage = policy.canManage(u);
  const tabs = [
    {
      value: 'overview',
      label: t('users.tabs.overview'),
      content: (
        <Card>
          <CardHeader
            title={t('users.info')}
            action={
              manage || self ? (
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  {t('users.edit')}
                </Button>
              ) : undefined
            }
          />
          <CardContent>
            <InfoList
              items={[
                [t('users.email'), u.email],
                [t('users.realm'), t(`roles.realm.${u.realm}`)],
                [t('users.role'), t(`roles.${u.role}`)],
                [t('users.locale'), u.locale === 'vi' ? 'Tiếng Việt' : 'English'],
                [t('users.timezone'), u.timezone],
                [
                  t('users.lastLogin'),
                  u.last_login_at ? fmt.dateTime(u.last_login_at) : t('users.never'),
                ],
                [t('users.createdAt'), fmt.dateTime(u.created_at)],
              ]}
            />
          </CardContent>
        </Card>
      ),
    },
    ...(u.role === 'ADMIN'
      ? [{ value: 'scopes', label: t('users.tabs.scopes'), content: <ScopesTab user={u} /> }]
      : []),
    { value: 'activity', label: t('users.tabs.activity'), content: <ActivityTab user={u} /> },
    {
      value: 'security',
      label: t('users.tabs.security'),
      content: (
        <Card>
          <CardHeader title={t('users.security')} description={t('users.securityHint')} />
          <CardContent className="flex flex-col gap-4">
            <InfoList
              items={[
                [t('sites.status'), <StatusBadge key="s" status={u.status} />],
                [
                  t('users.mfa'),
                  u.mfa_enabled ? (
                    <Badge key="m" tone="success">
                      {t('users.mfaOn')}
                    </Badge>
                  ) : (
                    <Badge key="m" tone="warning">
                      {t('users.mfaOff')}
                    </Badge>
                  ),
                ],
              ]}
            />
            {self && <Alert tone="info" title={t('users.selfNote')} />}
            {manage && (
              <div className="flex flex-wrap gap-2">
                {policy.canImpersonate(u) && (
                  <Button variant="outline" onClick={() => setImp(u)}>
                    {t('users.impersonate')}
                  </Button>
                )}
                {u.mfa_enabled && (
                  <Button variant="outline" onClick={() => setConfirm('reset-mfa')}>
                    {t('users.resetMfa')}
                  </Button>
                )}
                {u.status === 'locked' ? (
                  <Button variant="outline" onClick={() => setConfirm('unlock')}>
                    {t('users.unlock')}
                  </Button>
                ) : (
                  <Button variant="danger" onClick={() => setConfirm('lock')}>
                    {t('users.lock')}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ),
    },
  ];
  return (
    <>
      <DetailPage
        title={u.name}
        description={u.email}
        meta={
          <>
            <Badge tone={u.role === 'USER' ? 'neutral' : 'primary'}>{t(`roles.${u.role}`)}</Badge>
            <StatusBadge status={u.status} />
          </>
        }
        tabs={tabs}
      />
      {editing && (
        <EditDialog
          user={u}
          canRole={!self && policy.me.role === 'SUPER_ADMIN'}
          onClose={() => setEditing(false)}
        />
      )}
      <ImpersonateDialog user={imp} onClose={() => setImp(null)} />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone={confirm === 'lock' ? 'danger' : 'primary'}
        title={confirm ? t(`users.confirm.${confirm}`, { name: u.name }) : ''}
        description={confirm ? t(`users.confirmHint.${confirm}`) : ''}
        confirmLabel={confirm ? t(`users.confirmLabel.${confirm}`) : ''}
        onConfirm={() => (confirm ? act.mutateAsync(confirm).then(() => undefined) : undefined)}
      />
    </>
  );
}

function EditDialog({
  user,
  canRole,
  onClose,
}: {
  user: User;
  canRole: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit } = useForm<EditForm>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: user.name, email: user.email, locale: user.locale, role: user.role },
  });
  const roles = user.realm === 'admin' ? (['ADMIN', 'SUPER_ADMIN'] as const) : (['USER'] as const);
  const save = useAction(
    (v: EditForm) =>
      send('PATCH', '/api/v1/admin/users/{id}', {
        path: { id: user.uuid },
        body: canRole ? v : { name: v.name, email: v.email, locale: v.locale },
        headers: { 'If-Match': `"${user.updated_at}"` },
      }),
    { success: t('users.saved'), invalidate: [['admin', 'users']], onSuccess: onClose },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('users.editTitle', { name: user.name })}
      submitLabel={t('users.save')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      <TextField control={control} name="name" label={t('users.name')} />
      <TextField control={control} name="email" type="email" label={t('users.email')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="locale"
          label={t('users.locale')}
          options={[
            { value: 'vi', label: 'Tiếng Việt' },
            { value: 'en', label: 'English' },
          ]}
        />
        {canRole && (
          <SelectField
            control={control}
            name="role"
            label={t('users.role')}
            options={roles.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
          />
        )}
      </div>
    </FormDialog>
  );
}

/** Phạm vi của ADMIN: server (kèm mọi account trên đó) hoặc từng account. Chỉ Super Admin sửa. */
function ScopesTab({ user }: { user: User }) {
  const { t } = useTranslation('admin');
  const { me } = useUserPolicy();
  const [editing, setEditing] = useState(false);
  const scopes = useQuery({
    queryKey: ['admin', 'users', user.uuid, 'scopes'],
    queryFn: () => list('/api/v1/admin/users/{id}/scopes', undefined, { path: { id: user.uuid } }),
  });
  const columns: ColumnDef<Scope, unknown>[] = [
    {
      id: 'name',
      header: t('users.scopeName'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <AppLink
          href={`/admin/${row.original.scope_type === 'server' ? 'servers' : 'hosting-accounts'}/${row.original.uuid}`}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </AppLink>
      ),
    },
    {
      id: 'type',
      header: t('users.scopeType'),
      accessorKey: 'scope_type',
      cell: ({ row }) => (
        <Badge tone="neutral">{t(`users.scopeTypes.${row.original.scope_type}`)}</Badge>
      ),
    },
  ];
  return (
    <Card>
      <CardHeader
        title={t('users.scopes')}
        description={t('users.scopesHint')}
        action={
          me.role === 'SUPER_ADMIN' ? (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {t('users.editScopes')}
            </Button>
          ) : undefined
        }
      />
      <CardContent>
        <DataTable
          data={scopes.data ?? []}
          columns={columns}
          getRowId={(s) => s.uuid}
          primaryColumnId="name"
          caption={t('users.scopes')}
          empty={t('users.noScopes')}
        />
      </CardContent>
      {editing && scopes.data && (
        <ScopesDialog user={user} current={scopes.data} onClose={() => setEditing(false)} />
      )}
    </Card>
  );
}

function ScopesDialog({
  user,
  current,
  onClose,
}: {
  user: User;
  current: Scope[];
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const [picked, setPicked] = useState(() => new Set(current.map((s) => s.uuid)));
  const servers = useQuery({
    queryKey: ['admin', 'servers', 'options'],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const accounts = useQuery({
    queryKey: ['admin', 'accounts', 'all'],
    queryFn: () => list('/api/v1/admin/hosting-accounts'),
  });
  const serverIds = new Set((servers.data ?? []).map((s) => s.uuid));
  const save = useAction(
    () =>
      send('PUT', '/api/v1/admin/users/{id}/scopes', {
        path: { id: user.uuid },
        body: {
          scopes: [...picked].map((uuid) => ({
            scope_type: serverIds.has(uuid) ? ('server' as const) : ('hosting_account' as const),
            uuid,
          })),
        },
      }),
    { success: t('users.scopesSaved'), invalidate: [['admin', 'users']], onSuccess: onClose },
  );
  const toggle = (id: string, on: boolean) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const coveredByServer = (serverUuid: string) => picked.has(serverUuid);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('users.editScopesTitle', { name: user.name })}
      description={t('users.editScopesHint')}
      submitLabel={t('users.save')}
      pending={save.isPending}
      onSubmit={() => save.mutate()}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">{t('users.scopeTypes.server')}</legend>
        {(servers.data ?? []).map((s) => (
          <label key={s.uuid} className="flex items-center gap-2">
            <Checkbox
              checked={picked.has(s.uuid)}
              onCheckedChange={(c) => toggle(s.uuid, c === true)}
            />
            {s.name}
            <span className="text-sm text-muted">
              {t('users.accountsOn', { count: s.account_count })}
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">{t('users.scopeTypes.hosting_account')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(accounts.data ?? [])
            .filter((a) => a.lifecycle_state !== 'terminated')
            .map((a) => {
              const viaServer = coveredByServer(a.server.uuid);
              return (
                <label key={a.uuid} className="flex items-center gap-2">
                  <Checkbox
                    checked={viaServer || picked.has(a.uuid)}
                    disabled={viaServer}
                    onCheckedChange={(c) => toggle(a.uuid, c === true)}
                  />
                  <span className="min-w-0 break-all">{a.username}</span>
                  {viaServer && <span className="text-xs text-muted">{t('users.viaServer')}</span>}
                </label>
              );
            })}
        </div>
      </fieldset>
    </FormDialog>
  );
}

function ActivityTab({ user }: { user: User }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const logs = useQuery({
    queryKey: ['admin', 'audit', 'actor', user.uuid],
    queryFn: () => list('/api/v1/admin/audit-logs', { filters: { actor: user.uuid } }),
  });
  const columns: ColumnDef<Audit, unknown>[] = [
    {
      id: 'at',
      header: t('audit.at'),
      accessorKey: 'at',
      cell: ({ row }) => <span className="whitespace-nowrap">{fmt.dateTime(row.original.at)}</span>,
    },
    {
      id: 'action',
      header: t('audit.action'),
      accessorKey: 'action',
      cell: ({ row }) => auditLabel(t, row.original.action),
    },
    {
      id: 'resource',
      header: t('audit.resource'),
      accessorFn: (a) => a.resource?.type ?? '',
      cell: ({ row }) => {
        const href = resourceHref(row.original.resource);
        const label = row.original.resource
          ? t(`audit.types.${row.original.resource.type}` as never, {
              defaultValue: row.original.resource.type,
            })
          : '—';
        return href ? (
          <AppLink href={href} className="hover:underline">
            {label}
          </AppLink>
        ) : (
          label
        );
      },
    },
    {
      id: 'result',
      header: t('audit.result'),
      accessorKey: 'result',
      cell: ({ row }) => <StatusBadge status={row.original.result} />,
    },
  ];
  return (
    <Card>
      <CardHeader title={t('users.activity')} description={t('users.activityHint')} />
      <CardContent>
        <DataTable
          data={logs.data ?? []}
          columns={columns}
          getRowId={(a) => a.uuid}
          primaryColumnId="action"
          caption={t('users.activity')}
          empty={t('users.noActivity')}
        />
      </CardContent>
    </Card>
  );
}
