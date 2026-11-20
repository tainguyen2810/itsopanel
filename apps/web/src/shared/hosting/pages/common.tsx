import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { CodeBlock } from '@/ui/CodeBlock';
import { Dialog, DialogContent } from '@/ui/Dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/DropdownMenu';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { useParams } from '@tanstack/react-router';
import { get, list, type Row } from '@/shared/api/realm';
import { useRoutesInfo } from '@/shared/routing/RoutesContext';

export type Account = Row<'/hosting-accounts'>;
export type Website = Row<'/websites'>;

/** `$id` của route hiện tại. */
export function useRouteId(): string {
  return (useParams({ strict: false }) as { id: string }).id;
}

/**
 * Đường dẫn theo realm cho trang dùng chung: Portal không có trang server/gói, account nằm ở
 * `/portal/accounts/:id`. `isAdmin` bật phần chỉ Admin có (cột server, WAF…).
 */
export function useRealmLinks() {
  const { realm, basepath } = useRoutesInfo();
  return {
    realm,
    base: basepath,
    isAdmin: realm === 'admin',
    website: (id: string) => `${basepath}/websites/${id}`,
    account: (id: string) =>
      realm === 'admin' ? `${basepath}/hosting-accounts/${id}` : `${basepath}/accounts/${id}`,
    files: (account: string) => `${basepath}/files?account=${account}`,
    job: (id: string) => `${basepath}/jobs/${id}`,
  };
}

/** Tính năng theo gói hiện hành của account (PHP, SSH, cron, backup) — D-57. */
export function useFeatures(account: string | undefined) {
  return useQuery({
    queryKey: ['features', account],
    queryFn: () => get('/hosting-accounts/{id}/features', { path: { id: account ?? '' } }),
    enabled: account !== undefined && account !== '',
  });
}

/** Tài khoản hosting đang hoạt động trong phạm vi người dùng (dùng cho ô chọn ở các form). */
export function useActiveAccounts(enabled = true) {
  const q = useQuery({
    queryKey: ['admin', 'accounts', 'active'],
    queryFn: () => list('/hosting-accounts'),
    enabled,
  });
  const accounts = (q.data ?? []).filter((a) => a.lifecycle_state === 'active');
  return {
    ...q,
    accounts,
    options: accounts.map((a) => ({ value: a.uuid, label: `${a.username} · ${a.owner.name}` })),
  };
}

/** Website trong phạm vi, lọc theo tài khoản nếu có. */
export function useWebsites(account?: string, enabled = true) {
  const q = useQuery({
    queryKey: ['admin', 'websites', 'options', account ?? ''],
    queryFn: () =>
      list('/websites', account ? { filters: { hosting_account: account } } : undefined),
    enabled,
  });
  return {
    ...q,
    sites: q.data ?? [],
    options: (q.data ?? []).map((w) => ({ value: w.uuid, label: w.primary_domain })),
  };
}

/** Bộ lọc "Tài khoản" dùng chung cho các trang danh sách theo account. */
export function useAccountFilter() {
  const { t } = useTranslation('admin');
  const { options } = useActiveAccounts();
  return { key: 'hosting_account', label: t('sites.account'), options };
}

/** Ô chọn tài khoản độc lập (File Manager, DNS…). */
export function AccountSelect({
  id,
  value,
  onChange,
  label,
}: {
  id: string;
  value: string | undefined;
  onChange: (v: string) => void;
  label?: string;
}) {
  const { t } = useTranslation('admin');
  const { options } = useActiveAccounts();
  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5">
      <Label htmlFor={id}>{label ?? t('sites.account')}</Label>
      <Select
        id={id}
        value={value}
        onValueChange={onChange}
        options={options}
        placeholder={t('sites.pickAccount')}
      />
    </div>
  );
}

/** Hộp thoại hiện bí mật một lần (mật khẩu mới, webhook secret). */
export function SecretDialog({
  secret,
  title,
  onClose,
}: {
  secret: string | null;
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  return (
    <Dialog open={secret !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title} description={t('sites.secretOnce')}>
        <div className="flex flex-col gap-4">
          <CodeBlock code={secret ?? ''} label={t('sites.secret')} />
          <Alert tone="warning" title={t('sites.secretWarn')} />
          <div className="flex justify-end">
            <Button onClick={onClose}>{t('sites.secretDone')}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface RowAction {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/** Menu "…" cho thao tác trên một dòng bảng. */
export function RowMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  const shown = actions.filter((a) => !a.hidden);
  if (shown.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label}>
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {shown.map((a) => (
          <DropdownMenuItem
            key={a.label}
            onSelect={a.onSelect}
            {...(a.danger ? { className: 'text-danger-text' } : {})}
          >
            {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Cột chữ đơn cách (tên DB, đường dẫn…). */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-sm break-all">{children}</span>;
}
