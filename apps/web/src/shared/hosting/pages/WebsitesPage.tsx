import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { useUrlState } from '@/shared/page/useUrlState';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button, buttonVariants } from '@/ui/Button';
import { Card, CardContent } from '@/ui/Card';
import type { ColumnDef } from '@/ui/DataTable';
import { list, send } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import type { ListFilter } from '@/shared/page/ListPage';
import {
  useAccountFilter,
  useActiveAccounts,
  useFeatures,
  useRealmLinks,
  type Website,
} from './common';
import {
  ADMIN_SITE_TYPES,
  SITE_TYPES,
  certDaysLeft,
  websiteSchema,
  type DockerTarget,
  type WebsiteForm,
} from './forms';

/**
 * Danh sách website (Admin và Portal). Admin truyền thêm bộ lọc chỉ Admin có (server) qua
 * `extraFilters`; cột server/WAF chỉ hiện ở Admin.
 */
export default function WebsitesPage({
  extraFilters = [],
  dockerTargets,
}: {
  extraFilters?: ListFilter[];
  dockerTargets?: DockerTarget[];
}) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const links = useRealmLinks();
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useUrlState();
  const accountFilter = useAccountFilter();
  const columns: ColumnDef<Website, unknown>[] = [
    {
      id: 'domain',
      header: t('sites.domain'),
      accessorKey: 'primary_domain',
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={links.website(row.original.uuid)}
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
          href={links.account(row.original.hosting_account.uuid)}
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
          links.isAdmin ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('sites.add')}
            </Button>
          ) : (
            <AppLink href={`${links.base}/websites/new`} className={buttonVariants()}>
              <Plus aria-hidden />
              {t('sites.add')}
            </AppLink>
          )
        }
        queryKey={['admin', 'websites']}
        fetch={(q) => list('/websites', q)}
        filters={[accountFilter, ...extraFilters]}
        columns={links.isAdmin ? columns : columns.filter((c) => !ADMIN_ONLY.has(c.id ?? ''))}
        getRowId={(w) => w.uuid}
        primaryColumnId="domain"
      />
      <CreateWebsite
        open={creating || url.new === 'docker'}
        onOpenChange={(o) => {
          setCreating(o);
          if (!o && url.new) setUrl({ new: undefined, project: undefined });
        }}
        {...(dockerTargets ? { dockerTargets } : {})}
        {...(url.new === 'docker'
          ? { preset: { type: 'docker' as const, compose_project_uuid: url.project ?? '' } }
          : {})}
      />
    </>
  );
}

/** Cột chỉ Admin cần (hạ tầng, bảo mật). */
const ADMIN_ONLY = new Set(['server', 'waf']);

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
  compose_project_uuid: '',
  service: '',
};

/** Form tạo website: dùng cho hộp thoại (Admin, chi tiết account) và trang riêng (Portal). */
function useCreateWebsite(
  account: string | undefined,
  enabled: boolean,
  onCreated: () => void,
  preset: Partial<WebsiteForm> = {},
  targets?: DockerTarget[],
) {
  const { accounts, options } = useActiveAccounts(enabled);
  const initial = { ...EMPTY, ...preset, hosting_account_uuid: account ?? '' };
  const form = useForm<WebsiteForm>({
    resolver: zodResolver(websiteSchema),
    defaultValues: initial,
  });
  const [accId, type, projectId] = useWatch({
    control: form.control,
    name: ['hosting_account_uuid', 'type', 'compose_project_uuid'],
  });
  // Loại docker (chỉ Admin): chọn compose project và service có cổng đã cấp.
  const project = targets?.find((p) => p.uuid === projectId);

  const acc = accounts.find((a) => a.uuid === accId);
  // Phiên bản PHP chọn được theo gói (phiên bản gói hiện hành của account).
  const features = useFeatures(acc?.uuid);
  const create = useAction(
    (v: WebsiteForm) =>
      send('POST', '/websites', {
        body: {
          hosting_account_uuid: v.hosting_account_uuid,
          primary_domain: v.primary_domain,
          type: v.type,
          document_root: v.document_root,
          ssl_mode: v.ssl_mode,
          php_version: v.type === 'php' ? v.php_version : null,
          proxy_target: v.type === 'proxy' ? v.proxy_target : null,
          ...(v.type === 'docker'
            ? {
                docker_target: { compose_project_uuid: v.compose_project_uuid, service: v.service },
              }
            : {}),
        },
      }),
    {
      invalidate: [['admin', 'websites']],
      onSuccess: () => {
        form.reset(initial);
        onCreated();
      },
    },
  );
  return {
    form,
    options,
    acc,
    type,
    phpVersions: features.data?.php_versions ?? [],
    full: acc ? acc.usage.websites.used >= acc.usage.websites.limit : false,
    create,
    submit: () => void form.handleSubmit((v) => create.mutate(v))(),
    reset: () => form.reset(initial),
    isAdmin: targets !== undefined,
    projects: targets ?? [],
    project,
  };
}

function WebsiteFields({ f }: { f: ReturnType<typeof useCreateWebsite> }) {
  const { t } = useTranslation('admin');
  const { control } = f.form;
  const { acc, full, type, phpVersions, options, project } = f;
  return (
    <>
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
          options={(f.isAdmin ? ADMIN_SITE_TYPES : SITE_TYPES).map((x) => ({
            value: x,
            label: t(`sites.types.${x}`),
          }))}
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
      {type === 'docker' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            control={control}
            name="compose_project_uuid"
            label={t('sites.composeProject')}
            options={f.projects.map((p) => ({
              value: p.uuid,
              label: `${p.name} (${p.server.name})`,
            }))}
            placeholder={t('sites.pickProject')}
          />
          <SelectField
            control={control}
            name="service"
            label={t('sites.service')}
            options={(project?.ports ?? []).map((p) => ({
              value: p.service,
              label: `${p.service} → 127.0.0.1:${p.host_port}`,
            }))}
            placeholder={project ? t('sites.pickService') : t('sites.pickProjectFirst')}
            description={t('sites.dockerHint')}
          />
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {type !== 'docker' && (
          <TextField
            control={control}
            name="document_root"
            label={t('sites.docRoot')}
            description={t('sites.docRootHint')}
          />
        )}
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
    </>
  );
}

export function CreateWebsite({
  open,
  onOpenChange,
  account,
  preset,
  dockerTargets,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account?: string;
  preset?: Partial<WebsiteForm>;
  /** Chỉ Admin: bật loại website `docker`. */
  dockerTargets?: DockerTarget[];
}) {
  const { t } = useTranslation('admin');
  const f = useCreateWebsite(account, open, () => onOpenChange(false), preset, dockerTargets);
  const close = (o: boolean) => {
    if (!o) f.reset();
    onOpenChange(o);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t('sites.addTitle')}
      description={t('sites.addHint')}
      submitLabel={t('sites.create')}
      pending={f.create.isPending || f.full}
      onSubmit={f.submit}
    >
      <WebsiteFields f={f} />
    </FormDialog>
  );
}

/** Tạo website trên trang riêng (Portal `/websites/new`). */
export function WebsiteCreateCard({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation('admin');
  const f = useCreateWebsite(undefined, true, onCreated);
  return (
    <Card>
      <CardContent className="pt-4">
        <form
          noValidate
          className="flex max-w-2xl flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            f.submit();
          }}
        >
          <WebsiteFields f={f} />
          <div className="flex justify-end">
            <Button type="submit" disabled={f.create.isPending || f.full}>
              {t('sites.create')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
