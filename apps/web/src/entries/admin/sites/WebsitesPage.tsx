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
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { get, list, send } from '../api';
import { useAction } from '../useAction';
import { useAccountFilter, useActiveAccounts, type Website } from './common';
import { SITE_TYPES, certDaysLeft, websiteSchema, type WebsiteForm } from './forms';

export default function WebsitesPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [creating, setCreating] = useState(false);
  const accountFilter = useAccountFilter();
  const servers = useQuery({
    queryKey: ['admin', 'servers', { q: '' }],
    queryFn: () => list('/api/v1/admin/servers'),
  });
  const columns: ColumnDef<Website, unknown>[] = [
    {
      id: 'domain',
      header: t('sites.domain'),
      accessorKey: 'primary_domain',
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/websites/${row.original.uuid}`}
            className="font-medium break-all hover:underline"
          >
            {row.original.primary_domain}
          </AppLink>
          {row.original.domains_count > 1 && (
            <p className="text-sm text-muted">
              {t('sites.moreDomains', { count: row.original.domains_count - 1 })}
            </p>
          )}
        </div>
      ),
    },
    {
      id: 'account',
      header: t('sites.account'),
      accessorFn: (w) => w.hosting_account.username,
      cell: ({ row }) => (
        <AppLink
          href={`/admin/hosting-accounts/${row.original.hosting_account.uuid}`}
          className="font-mono hover:underline"
        >
          {row.original.hosting_account.username}
        </AppLink>
      ),
    },
    { id: 'server', header: t('sites.server'), accessorFn: (w) => w.server.name },
    {
      id: 'type',
      header: t('sites.type'),
      accessorKey: 'type',
      cell: ({ row }) => (
        <span className="flex items-center gap-1.5">
          {t(`sites.types.${row.original.type}`)}
          {row.original.php_version && <Badge tone="neutral">PHP {row.original.php_version}</Badge>}
        </span>
      ),
    },
    {
      id: 'ssl',
      header: 'SSL',
      accessorFn: (w) => w.certificate_expires_at ?? '',
      cell: ({ row }) => <SslCell w={row.original} />,
    },
    {
      id: 'waf',
      header: 'WAF',
      accessorFn: (w) => (w.waf_enabled ? 1 : 0),
      cell: ({ row }) =>
        row.original.waf_enabled ? (
          <Badge tone="success">{t('sites.on')}</Badge>
        ) : (
          <Badge tone="neutral">{t('sites.off')}</Badge>
        ),
    },
    {
      id: 'status',
      header: t('sites.status'),
      accessorKey: 'status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: 'updated',
      header: t('sites.updated'),
      accessorFn: (w) => w.updated_at,
      cell: ({ row }) => fmt.rel(row.original.updated_at),
    },
  ];
  return (
    <>
      <ListPage<Website>
        title={t('sites.title')}
        description={t('sites.description')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('sites.add')}
          </Button>
        }
        queryKey={['admin', 'websites']}
        fetch={(q) => list('/api/v1/admin/websites', q)}
        filters={[
          accountFilter,
          {
            key: 'server',
            label: t('sites.server'),
            options: (servers.data ?? []).map((s) => ({ value: s.uuid, label: s.name })),
          },
        ]}
        columns={columns}
        getRowId={(w) => w.uuid}
        primaryColumnId="domain"
      />
      <CreateWebsite open={creating} onOpenChange={setCreating} />
    </>
  );
}

function SslCell({ w }: { w: Website }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  if (w.ssl_mode === 'none') return <Badge tone="neutral">{t('sites.noSsl')}</Badge>;
  const left = certDaysLeft(w.certificate_expires_at);
  if (left === null) return <StatusBadge status="pending" />;
  const status = left < 0 ? 'expired' : left <= 14 ? 'expiring' : 'valid';
  return (
    <div className="flex flex-col items-start gap-0.5">
      <StatusBadge status={status} />
      <span className="text-xs text-muted">
        {w.certificate_expires_at ? fmt.date(w.certificate_expires_at) : '—'}
      </span>
    </div>
  );
}

const EMPTY: WebsiteForm = {
  hosting_account_uuid: '',
  primary_domain: '',
  type: 'php',
  php_version: '',
  document_root: 'public',
  ssl_mode: 'acme',
  proxy_target: 'http://127.0.0.1:3000',
};

export function CreateWebsite({
  open,
  onOpenChange,
  account,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account?: string;
}) {
  const { t } = useTranslation('admin');
  const { accounts, options } = useActiveAccounts(open);
  const { control, handleSubmit, reset } = useForm<WebsiteForm>({
    resolver: zodResolver(websiteSchema),
    defaultValues: { ...EMPTY, hosting_account_uuid: account ?? '' },
  });
  const [accId, type] = useWatch({ control, name: ['hosting_account_uuid', 'type'] });
  const acc = accounts.find((a) => a.uuid === accId);
  // Phiên bản PHP chọn được theo gói (phiên bản gói hiện hành của account).
  const pkg = useQuery({
    queryKey: ['admin', 'package', acc?.package.uuid],
    queryFn: () =>
      get('/api/v1/admin/hosting-packages/{id}', { path: { id: acc?.package.uuid ?? '' } }),
    enabled: acc !== undefined,
  });
  const phpVersions = pkg.data?.limits.php_versions ?? [];
  const full = acc ? acc.usage.websites.used >= acc.usage.websites.limit : false;
  const close = (o: boolean) => {
    if (!o) reset({ ...EMPTY, hosting_account_uuid: account ?? '' });
    onOpenChange(o);
  };
  const create = useAction(
    (v: WebsiteForm) =>
      send('POST', '/api/v1/admin/websites', {
        body: {
          hosting_account_uuid: v.hosting_account_uuid,
          primary_domain: v.primary_domain,
          type: v.type,
          document_root: v.document_root,
          ssl_mode: v.ssl_mode,
          php_version: v.type === 'php' ? v.php_version : null,
          proxy_target: v.type === 'proxy' ? v.proxy_target : null,
        },
      }),
    { invalidate: [['admin', 'websites']], onSuccess: () => close(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t('sites.addTitle')}
      description={t('sites.addHint')}
      submitLabel={t('sites.create')}
      pending={create.isPending || full}
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
            ? t('sites.quota', { used: acc.usage.websites.used, limit: acc.usage.websites.limit })
            : undefined
        }
      />
      {full && <p className="text-sm text-danger-text">{t('sites.quotaFull')}</p>}
      <TextField
        control={control}
        name="primary_domain"
        label={t('sites.domain')}
        placeholder="shop.anphat.vn"
        autoComplete="off"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="type"
          label={t('sites.type')}
          options={SITE_TYPES.map((x) => ({ value: x, label: t(`sites.types.${x}`) }))}
        />
        {type === 'php' && (
          <SelectField
            control={control}
            name="php_version"
            label={t('sites.phpVersion')}
            options={phpVersions.map((v) => ({ value: v, label: `PHP ${v}` }))}
            placeholder={acc ? t('sites.pickPhp') : t('sites.pickAccountFirst')}
          />
        )}
        {type === 'proxy' && (
          <TextField
            control={control}
            name="proxy_target"
            label={t('sites.proxyTarget')}
            description={t('sites.proxyHint')}
          />
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          control={control}
          name="document_root"
          label={t('sites.docRoot')}
          description={t('sites.docRootHint')}
        />
        <SelectField
          control={control}
          name="ssl_mode"
          label="SSL"
          options={[
            { value: 'acme', label: t('sites.sslAcme') },
            { value: 'none', label: t('sites.sslNone') },
          ]}
        />
      </div>
    </FormDialog>
  );
}
