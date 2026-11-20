import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { Avatar } from '@/ui/Feedback';
import { list, send } from '../api';
import { useAction } from '../useAction';
import { RowMenu } from '../sites/common';
import { CreateUserDialog, ImpersonateDialog, useUserPolicy, type User } from './users';

type Act = 'lock' | 'unlock' | 'reset-mfa';

export default function UsersPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const policy = useUserPolicy();
  const [creating, setCreating] = useState(false);
  const [imp, setImp] = useState<User | null>(null);
  const [confirm, setConfirm] = useState<{ user: User; act: Act } | null>(null);
  const act = useAction(
    ({ user, act }: { user: User; act: Act }) =>
      send('POST', `/api/v1/admin/users/{id}:${act}` as '/api/v1/admin/users/{id}:lock', {
        path: { id: user.uuid },
      }),
    { invalidate: [['admin', 'users']], onSuccess: () => setConfirm(null) },
  );
  const columns: ColumnDef<User, unknown>[] = [
    {
      id: 'name',
      header: t('users.user'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={row.original.name} />
          <div className="min-w-0">
            <AppLink
              href={`/admin/users/${row.original.uuid}`}
              className="font-medium break-all hover:underline"
            >
              {row.original.name}
            </AppLink>
            <p className="text-sm break-all text-muted">{row.original.email}</p>
          </div>
        </div>
      ),
    },
    {
      id: 'role',
      header: t('users.role'),
      accessorKey: 'role',
      cell: ({ row }) => (
        <Badge
          tone={
            row.original.role === 'SUPER_ADMIN'
              ? 'accent'
              : row.original.role === 'ADMIN'
                ? 'primary'
                : 'neutral'
          }
        >
          {t(`roles.${row.original.role}`)}
        </Badge>
      ),
    },
    {
      id: 'mfa',
      header: t('users.mfa'),
      accessorFn: (u) => (u.mfa_enabled ? 1 : 0),
      cell: ({ row }) =>
        row.original.mfa_enabled ? (
          <Badge tone="success">{t('users.mfaOn')}</Badge>
        ) : (
          <Badge tone="warning">{t('users.mfaOff')}</Badge>
        ),
    },
    {
      id: 'login',
      header: t('users.lastLogin'),
      accessorFn: (u) => u.last_login_at ?? '',
      cell: ({ row }) =>
        row.original.last_login_at ? fmt.rel(row.original.last_login_at) : t('users.never'),
    },
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
      cell: ({ row }) => {
        const u = row.original;
        if (!policy.canManage(u)) return null;
        return (
          <RowMenu
            label={t('users.actionsFor', { name: u.name })}
            actions={[
              {
                label: t('users.impersonate'),
                onSelect: () => setImp(u),
                hidden: !policy.canImpersonate(u),
              },
              {
                label: t('users.resetMfa'),
                onSelect: () => setConfirm({ user: u, act: 'reset-mfa' }),
                hidden: !u.mfa_enabled,
              },
              {
                label: t('users.unlock'),
                onSelect: () => setConfirm({ user: u, act: 'unlock' }),
                hidden: u.status !== 'locked',
              },
              {
                label: t('users.lock'),
                onSelect: () => setConfirm({ user: u, act: 'lock' }),
                hidden: u.status === 'locked',
                danger: true,
              },
            ]}
          />
        );
      },
    },
  ];
  return (
    <>
      <ListPage<User>
        title={t('users.title')}
        description={t('users.description')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <UserPlus aria-hidden />
            {t('users.add')}
          </Button>
        }
        queryKey={['admin', 'users']}
        fetch={async (q) => {
          const rows = await list('/api/v1/admin/users', {
            ...q,
            filters: { ...(q.filters.realm ? { realm: q.filters.realm } : {}) },
          });
          return q.filters.role ? rows.filter((u) => u.role === q.filters.role) : rows;
        }}
        filters={[
          {
            key: 'realm',
            label: t('users.realm'),
            options: (['admin', 'portal'] as const).map((r) => ({
              value: r,
              label: t(`roles.realm.${r}`),
            })),
          },
          {
            key: 'role',
            label: t('users.role'),
            options: (['SUPER_ADMIN', 'ADMIN', 'USER'] as const).map((r) => ({
              value: r,
              label: t(`roles.${r}`),
            })),
          },
        ]}
        columns={columns}
        getRowId={(u) => u.uuid}
        primaryColumnId="name"
      />
      <CreateUserDialog open={creating} onOpenChange={setCreating} />
      <ImpersonateDialog user={imp} onClose={() => setImp(null)} />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone={confirm?.act === 'lock' ? 'danger' : 'primary'}
        title={confirm ? t(`users.confirm.${confirm.act}`, { name: confirm.user.name }) : ''}
        description={confirm ? t(`users.confirmHint.${confirm.act}`) : ''}
        confirmLabel={confirm ? t(`users.confirmLabel.${confirm.act}`) : ''}
        onConfirm={() => (confirm ? act.mutateAsync(confirm).then(() => undefined) : undefined)}
      />
    </>
  );
}
