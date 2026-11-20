import { Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { Badge } from '@/ui/Badge';
import { Card, CardContent } from '@/ui/Card';
import { list, type Row } from '../api';
import { PERMISSION_GROUPS, allows } from './permissions';

type Role = Row<'/api/v1/admin/roles'>;

/** Ma trận quyền chỉ xem: vai trò cố định trong code (RBAC), phạm vi ADMIN giao ở trang người dùng. */
export function RoleMatrix({ roles }: { roles: Role[] }) {
  const { t } = useTranslation('admin');
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-base">
        <caption className="sr-only">{t('roles.matrix')}</caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-3 text-left font-medium text-muted">
              {t('roles.permission')}
            </th>
            {roles.map((r) => (
              <th key={r.key} scope="col" className="px-3 py-2 text-center font-medium">
                <span className="block">{t(`roles.${r.key}`)}</span>
                <Badge tone="neutral" className="mt-1">
                  {t(`roles.realm.${r.realm}`)}
                </Badge>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERMISSION_GROUPS.map((g) => (
            <Fragment key={g.key}>
              <tr>
                <th
                  colSpan={roles.length + 1}
                  scope="colgroup"
                  className="bg-surface-2 px-2 py-1.5 text-left text-sm font-semibold"
                >
                  {t(`roles.groups.${g.key}`)}
                </th>
              </tr>
              {g.actions.map((a) => {
                const perm = `${g.key}.${a}`;
                return (
                  <tr key={perm} className="border-b border-border">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {t(`roles.actions.${a}`)}
                      <span className="ml-2 font-mono text-xs text-muted">{perm}</span>
                    </th>
                    {roles.map((r) => {
                      const ok = allows(r.permissions, perm);
                      return (
                        <td key={r.key} className="px-3 py-2 text-center" data-allowed={ok}>
                          {ok ? (
                            <Check aria-hidden className="mx-auto size-4 text-success-text" />
                          ) : (
                            <Minus aria-hidden className="mx-auto size-4 text-subtle" />
                          )}
                          <span className="sr-only">{ok ? t('roles.yes') : t('roles.no')}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RolesPage() {
  const { t } = useTranslation('admin');
  const q = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => list('/api/v1/admin/roles') });
  return (
    <>
      <PageHeader title={t('roles.title')} description={t('roles.description')} />
      <div className="flex flex-col gap-4">
        <Alert tone="info" title={t('roles.readOnly')}>
          {t('roles.readOnlyHint')}
        </Alert>
        <Card>
          <CardContent className="pt-4">
            {q.isLoading && <TableSkeleton />}
            {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
            {q.data && <RoleMatrix roles={q.data} />}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
