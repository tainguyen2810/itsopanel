import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, TextField } from '@/shared/page/fields';
import { DetailPage } from '@/shared/page/DetailPage';
import { FormDialog } from '@/shared/page/FormDialog';
import { InfoList } from '@/shared/page/InfoList';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton, TableSkeleton } from '@/shared/page/states';
import { useCrumbName } from '@/shared/routing/crumbs';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import { CodeBlock } from '@/ui/CodeBlock';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/DropdownMenu';
import { FormField } from '@/ui/FormField';
import { Textarea } from '@/ui/Input';
import { Select } from '@/ui/Select';
import { get, list, send, type Data, type Row } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { Mono, RowMenu, useFeatures, useRealmLinks, useRouteId } from './common';
import {
  certDaysLeft,
  certUploadBody,
  certUploadSchema,
  domainSchema,
  nginxSchema,
  phpSchema,
  type CertUploadForm,
  type PhpForm,
} from './forms';

export type Site = Data<'/websites/{id}'>;
type Domain = Row<'/websites/{id}/domains'>;
type Cert = Row<'/certificates'>;

export const keyOf = (id: string) => ['admin', 'website', id];

export interface SiteTab {
  value: string;
  label: string;
  content: ReactNode;
}

/**
 * Chi tiết website (Admin và Portal). Phần chỉ Admin có (quét mã độc, WAF) do trang Admin
 * truyền vào qua `extraActions` / `extraTabs`.
 */
export default function WebsiteDetailPage({
  extraActions,
  extraTabs,
}: {
  extraActions?: (w: Site) => ReactNode;
  extraTabs?: (w: Site) => SiteTab[];
}) {
  const { t } = useTranslation('admin');
  const id = useRouteId();
  const links = useRealmLinks();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: keyOf(id),
    queryFn: () => get('/websites/{id}', { path: { id } }),
  });
  useCrumbName(id, q.data?.primary_domain);
  const [removing, setRemoving] = useState(false);
  const remove = useAction(() => send('DELETE', '/websites/{id}', { path: { id } }), {
    invalidate: [['admin', 'websites']],
    onSuccess: () => void navigate({ to: '/websites' }),
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <>
        <PageHeader title={t('sites.detail')} />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const w = q.data;
  const php = w.type === 'php';
  return (
    <>
      <DetailPage
        title={w.primary_domain}
        meta={
          <>
            <StatusBadge
              status={w.status}
              desiredVersion={w.spec_version}
              observedVersion={w.observed_version}
            />
            <Badge tone="neutral">{t(`sites.types.${w.type}` as never)}</Badge>
          </>
        }
        description={
          links.isAdmin
            ? `${w.hosting_account.username} · ${w.server.name}`
            : w.hosting_account.username
        }
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">
                {t('sites.actions')}
                <ChevronDown aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {extraActions?.(w)}
              <DropdownMenuItem asChild>
                <AppLink href={links.files(w.hosting_account.uuid)}>{t('sites.openFiles')}</AppLink>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-danger-text" onSelect={() => setRemoving(true)}>
                {t('sites.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
        tabs={[
          { value: 'overview', label: t('sites.tabs.overview'), content: <Overview w={w} /> },
          { value: 'domains', label: t('sites.tabs.domains'), content: <Domains w={w} /> },
          ...(php ? [{ value: 'php', label: t('sites.tabs.php'), content: <PhpTab w={w} /> }] : []),
          { value: 'ssl', label: t('sites.tabs.ssl'), content: <SslTab w={w} /> },
          { value: 'nginx', label: t('sites.tabs.nginx'), content: <NginxTab w={w} /> },
          ...(extraTabs?.(w) ?? []),
          { value: 'logs', label: t('sites.tabs.logs'), content: <LogsTab w={w} /> },
          { value: 'backup', label: t('sites.tabs.backup'), content: <BackupTab w={w} /> },
        ]}
      />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t('sites.deleteTitle', { name: w.primary_domain })}
        description={t('sites.deleteHint')}
        confirmLabel={t('sites.delete')}
        confirmName={w.primary_domain}
        onConfirm={() => remove.mutateAsync().then(() => undefined)}
      />
    </>
  );
}

function Overview({ w }: { w: Site }) {
  const { t } = useTranslation('admin');
  const links = useRealmLinks();
  const fmt = useFmt();
  const left = certDaysLeft(w.certificate_expires_at);
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title={t('sites.info')} />
        <CardContent>
          <InfoList
            items={[
              [
                t('sites.account'),
                <AppLink
                  key="a"
                  href={links.account(w.hosting_account.uuid)}
                  className="font-mono hover:underline"
                >
                  {w.hosting_account.username}
                </AppLink>,
              ],
              ...(links.isAdmin
                ? [
                    [
                      t('sites.server'),
                      <AppLink
                        key="s"
                        href={`${links.base}/servers/${w.server.uuid}`}
                        className="hover:underline"
                      >
                        {w.server.name}
                      </AppLink>,
                    ] as [string, ReactNode],
                  ]
                : []),
              [t('sites.type'), t(`sites.types.${w.type}` as never)],
              ['PHP', w.php_version ?? '—'],
              [
                t('sites.docRoot'),
                <Mono key="d">{`sites/${w.primary_domain}/${w.document_root}`}</Mono>,
              ],
              [t('sites.domainsCount'), String(w.domains_count)],
              [t('sites.createdAt'), fmt.dateTime(w.created_at)],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader title={t('sites.health')} />
        <CardContent className="flex flex-col gap-3 text-base">
          <div className="flex items-center justify-between gap-2">
            <span>SSL</span>
            {w.ssl_mode === 'none' ? (
              <Badge tone="neutral">{t('sites.noSsl')}</Badge>
            ) : left === null ? (
              <StatusBadge status="pending" />
            ) : (
              <span className="text-sm">
                {left < 0 ? t('sites.certExpired') : t('sites.certDays', { count: left })}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>WAF</span>
            <Badge tone={w.waf_enabled ? 'success' : 'neutral'}>
              {w.waf_enabled ? t('sites.on') : t('sites.off')}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>{t('sites.sync')}</span>
            <StatusBadge
              status={w.status}
              desiredVersion={w.spec_version}
              observedVersion={w.observed_version}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Domains({ w }: { w: Site }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Domain | null>(null);
  const remove = useAction(
    (d: Domain) =>
      send('DELETE', '/websites/{id}/domains/{domain}', {
        path: { id: w.uuid, domain: d.uuid },
      }),
    { onSuccess: () => setRemoving(null) },
  );
  const columns: ColumnDef<Domain, unknown>[] = [
    {
      id: 'name',
      header: t('sites.domain'),
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-medium break-all">{row.original.name}</span>,
    },
    {
      id: 'type',
      header: t('sites.domainType'),
      accessorFn: (d) => t(`sites.domainTypes.${d.type}` as never),
    },
    {
      id: 'verified',
      header: t('sites.verified'),
      accessorFn: (d) => d.verified_at ?? '',
      cell: ({ row }) =>
        row.original.verified_at ? (
          <span className="text-sm">{fmt.date(row.original.verified_at)}</span>
        ) : (
          <StatusBadge status="pending" />
        ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) =>
        row.original.type === 'primary' ? null : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('sites.removeDomain', { name: row.original.name })}
            onClick={() => setRemoving(row.original)}
          >
            <Trash2 aria-hidden />
          </Button>
        ),
    },
  ];
  return (
    <>
      <ListPage<Domain>
        embedded
        search={false}
        title={t('sites.tabs.domains')}
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            {t('sites.addDomain')}
          </Button>
        }
        queryKey={[...keyOf(w.uuid), 'domains']}
        fetch={() => list('/websites/{id}/domains', undefined, { path: { id: w.uuid } })}
        columns={columns}
        getRowId={(d) => d.uuid}
        primaryColumnId="name"
      />
      <AddDomain w={w} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('sites.removeDomainTitle', { name: removing?.name ?? '' })}
        description={t('sites.removeDomainHint')}
        confirmLabel={t('sites.remove')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function AddDomain({
  w,
  open,
  onOpenChange,
}: {
  w: Site;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  type F = { name: string; type: 'alias' | 'redirect' | 'subdomain' };
  const { control, handleSubmit, reset } = useForm<F>({
    resolver: zodResolver(domainSchema),
    defaultValues: { name: '', type: 'alias' },
  });
  const add = useAction(
    (v: F) => send('POST', '/websites/{id}/domains', { path: { id: w.uuid }, body: v }),
    {
      onSuccess: () => {
        reset();
        onOpenChange(false);
      },
    },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('sites.addDomainTitle', { name: w.primary_domain })}
      description={t('sites.addDomainHint')}
      submitLabel={t('sites.addDomain')}
      pending={add.isPending}
      onSubmit={() => void handleSubmit((v) => add.mutate(v))()}
    >
      <TextField
        control={control}
        name="name"
        label={t('sites.domain')}
        placeholder={`www.${w.primary_domain}`}
      />
      <SelectField
        control={control}
        name="type"
        label={t('sites.domainType')}
        options={(['alias', 'redirect', 'subdomain'] as const).map((x) => ({
          value: x,
          label: t(`sites.domainTypes.${x}`),
        }))}
      />
    </FormDialog>
  );
}

export function SettingsCard({
  title,
  description,
  pending,
  onSubmit,
  children,
}: {
  title: string;
  description?: string;
  pending: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation('admin');
  return (
    <Card>
      <CardHeader title={title} {...(description ? { description } : {})} />
      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {children}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {t('sites.apply')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PhpTab({ w }: { w: Site }) {
  const q = useQuery({
    queryKey: [...keyOf(w.uuid), 'php'],
    queryFn: () => get('/websites/{id}/php', { path: { id: w.uuid } }),
  });
  const features = useFeatures(w.hosting_account.uuid);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data || !features.data) return <TableSkeleton rows={4} />;
  return <PhpForm w={w} value={q.data} limits={features.data} />;
}

function PhpForm({
  w,
  value,
  limits: L,
}: {
  w: Site;
  value: Data<'/websites/{id}/php'>;
  limits: Data<'/hosting-accounts/{id}/features'>;
}) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit } = useForm<PhpForm>({
    resolver: zodResolver(phpSchema),
    defaultValues: {
      version: value.version ?? '8.3',
      memory_limit: value.memory_limit ?? '256m',
      max_execution_time: value.max_execution_time ?? 60,
      upload_max_filesize: value.upload_max_filesize ?? '64m',
      pm_max_children: value.pm_max_children ?? 4,
    },
  });
  const save = useAction((v: PhpForm) =>
    send('PATCH', '/websites/{id}/php', { path: { id: w.uuid }, body: v }),
  );
  return (
    <SettingsCard
      title={t('sites.phpTitle')}
      description={t('sites.phpHint', { max: L.php_workers_max })}
      pending={save.isPending}
      onSubmit={() =>
        void handleSubmit((v) => {
          if (v.pm_max_children > L.php_workers_max) return;
          save.mutate(v);
        })()
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SelectField
          control={control}
          name="version"
          label={t('sites.phpVersion')}
          options={(L.php_versions.length ? L.php_versions : [value.version ?? '8.3']).map((v) => ({
            value: v,
            label: `PHP ${v}`,
          }))}
        />
        <TextField control={control} name="memory_limit" label="memory_limit" />
        <TextField
          control={control}
          name="max_execution_time"
          type="number"
          label={t('sites.maxExecution')}
        />
        <TextField control={control} name="upload_max_filesize" label="upload_max_filesize" />
        <TextField
          control={control}
          name="pm_max_children"
          type="number"
          label={t('sites.workers')}
          description={t('sites.workersHint', { max: L.php_workers_max })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('sites.disabledFunctions')}</span>
        <p className="font-mono text-sm break-words text-muted">
          {(value.disable_functions ?? []).join(', ')}
        </p>
      </div>
    </SettingsCard>
  );
}

function SslTab({ w }: { w: Site }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [removing, setRemoving] = useState<Cert | null>(null);
  const [uploading, setUploading] = useState(false);
  const issue = useAction(() =>
    send('POST', '/websites/{id}/certificates', {
      path: { id: w.uuid },
      body: { source: 'acme', domains: [w.primary_domain] },
    }),
  );
  const renew = useAction((c: Cert) =>
    send('POST', '/certificates/{id}:renew', { path: { id: c.uuid }, body: {} }),
  );
  const remove = useAction(
    (c: Cert) => send('DELETE', '/certificates/{id}', { path: { id: c.uuid } }),
    { onSuccess: () => setRemoving(null) },
  );
  const columns: ColumnDef<Cert, unknown>[] = [
    {
      id: 'domains',
      header: t('sites.certDomains'),
      accessorFn: (c) => c.domains.join(', '),
      cell: ({ row }) => <span className="break-all">{row.original.domains.join(', ')}</span>,
    },
    { id: 'issuer', header: t('sites.issuer'), accessorKey: 'issuer' },
    {
      id: 'expires',
      header: t('sites.expires'),
      accessorFn: (c) => c.not_after,
      cell: ({ row }) => fmt.date(row.original.not_after),
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
      cell: ({ row }) => (
        <RowMenu
          label={t('sites.certActions', { name: row.original.domains[0] ?? '' })}
          actions={[
            {
              label: t('sites.renew'),
              onSelect: () => renew.mutate(row.original),
              hidden: row.original.source !== 'acme',
            },
            { label: t('sites.remove'), onSelect: () => setRemoving(row.original), danger: true },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Cert>
        embedded
        search={false}
        title={t('sites.tabs.ssl')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setUploading(true)}>
              <Upload aria-hidden />
              {t('sites.uploadCert')}
            </Button>
            <Button size="sm" onClick={() => issue.mutate()} disabled={issue.isPending}>
              <RefreshCw aria-hidden />
              {t('sites.issueAcme')}
            </Button>
          </div>
        }
        queryKey={[...keyOf(w.uuid), 'certs']}
        fetch={async () => (await list('/certificates')).filter((c) => c.website.uuid === w.uuid)}
        columns={columns}
        getRowId={(c) => c.uuid}
        primaryColumnId="domains"
        empty={<p className="p-6 text-center text-base text-muted">{t('sites.noCert')}</p>}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('sites.removeCertTitle')}
        description={t('sites.removeCertHint')}
        confirmLabel={t('sites.remove')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
      <CertUploadDialog w={w} open={uploading} onOpenChange={setUploading} />
    </>
  );
}

/** Tải chứng chỉ riêng (ssl_mode=custom): khóa riêng chỉ gửi một lần, API lưu mã hóa và không trả lại. */
function CertUploadDialog({
  w,
  open,
  onOpenChange,
}: {
  w: Site;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit, reset } = useForm<CertUploadForm>({
    resolver: zodResolver(certUploadSchema),
    defaultValues: { domains: w.primary_domain, certificate_pem: '', private_key_pem: '' },
  });
  const upload = useAction(
    (v: CertUploadForm) =>
      send('POST', '/websites/{id}/certificates', {
        path: { id: w.uuid },
        body: certUploadBody(v),
      }),
    {
      onSuccess: () => {
        reset();
        onOpenChange(false);
      },
    },
  );
  const pem = (name: 'certificate_pem' | 'private_key_pem', label: string, hint: string) => (
    <FormField
      control={control}
      name={name}
      label={label}
      description={hint}
      render={(f) => (
        <Textarea
          {...f}
          rows={5}
          className="font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
          value={String(f.value ?? '')}
        />
      )}
    />
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('sites.uploadCertTitle', { name: w.primary_domain })}
      description={t('sites.uploadCertHint')}
      submitLabel={t('sites.uploadCert')}
      pending={upload.isPending}
      onSubmit={() => void handleSubmit((v) => upload.mutate(v))()}
    >
      <TextField control={control} name="domains" label={t('sites.certDomains')} />
      {pem('certificate_pem', t('sites.certPem'), t('sites.certPemHint'))}
      {pem('private_key_pem', t('sites.keyPem'), t('sites.keyPemHint'))}
    </FormDialog>
  );
}

function NginxTab({ w }: { w: Site }) {
  const q = useQuery({
    queryKey: [...keyOf(w.uuid), 'nginx'],
    queryFn: () => get('/websites/{id}/nginx', { path: { id: w.uuid } }),
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <TableSkeleton rows={4} />;
  return <NginxForm w={w} value={q.data} />;
}

function NginxForm({ w, value }: { w: Site; value: Data<'/websites/{id}/nginx'> }) {
  const { t } = useTranslation('admin');
  type F = { client_max_body_size: string; http2: boolean; hsts: boolean };
  const { control, handleSubmit } = useForm<F>({
    resolver: zodResolver(nginxSchema),
    defaultValues: {
      client_max_body_size: value.client_max_body_size ?? '64m',
      http2: value.http2 ?? true,
      hsts: value.hsts ?? false,
    },
  });
  const save = useAction((v: F) =>
    send('PATCH', '/websites/{id}/nginx', { path: { id: w.uuid }, body: v }),
  );
  const headers = Object.entries(value.extra_headers ?? {});
  return (
    <div className="flex flex-col gap-4">
      <SettingsCard
        title={t('sites.nginxTitle')}
        description={t('sites.nginxHint')}
        pending={save.isPending}
        onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            control={control}
            name="client_max_body_size"
            label="client_max_body_size"
            description={t('sites.sizeHint')}
          />
          {(['http2', 'hsts'] as const).map((k) => (
            <FormField
              key={k}
              control={control}
              name={k}
              label={k === 'http2' ? 'HTTP/2' : 'HSTS'}
              description={t(`sites.${k}Hint`)}
              render={(f) => (
                <Switch
                  id={f.id}
                  checked={f.value as boolean}
                  onCheckedChange={f.onChange}
                  aria-describedby={f['aria-describedby']}
                />
              )}
            />
          ))}
        </div>
      </SettingsCard>
      <Card>
        <CardHeader title={t('sites.headers')} description={t('sites.headersHint')} />
        <CardContent>
          {headers.length === 0 ? (
            <p className="text-base text-muted">{t('sites.none')}</p>
          ) : (
            <CodeBlock code={headers.map(([k, v]) => `${k}: ${v}`).join('\n')} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LogsTab({ w }: { w: Site }) {
  const { t } = useTranslation('admin');
  const [kind, setKind] = useState<'access' | 'error'>('access');
  const [lines, setLines] = useState('200');
  const q = useQuery({
    queryKey: [...keyOf(w.uuid), 'logs', kind, lines],
    queryFn: () =>
      get('/websites/{id}/logs', {
        path: { id: w.uuid },
        query: { kind, lines: Number(lines) },
      }),
  });
  return (
    <Card>
      <CardHeader
        title={t('sites.logsTitle')}
        description={t('sites.logsHint')}
        action={
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label={t('sites.logKind')}
              value={kind}
              onValueChange={(v) => setKind(v as 'access' | 'error')}
              options={[
                { value: 'access', label: t('sites.logAccess') },
                { value: 'error', label: t('sites.logError') },
              ]}
              className="w-36"
            />
            <Select
              aria-label={t('sites.logLines')}
              value={lines}
              onValueChange={setLines}
              options={['50', '200', '1000'].map((x) => ({
                value: x,
                label: t('sites.lines', { count: Number(x) }),
              }))}
              className="w-32"
            />
            <Button
              variant="outline"
              size="icon"
              aria-label={t('sites.refresh')}
              onClick={() => void q.refetch()}
            >
              <RefreshCw aria-hidden />
            </Button>
          </div>
        }
      />
      <CardContent>
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data ? (
          <CodeBlock
            code={q.data.length ? q.data.join('\n') : t('sites.logEmpty')}
            className="max-h-[28rem] overflow-auto"
          />
        ) : (
          <TableSkeleton rows={6} />
        )}
      </CardContent>
    </Card>
  );
}

function BackupTab({ w }: { w: Site }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  type B = Row<'/backup-snapshots'>;
  return (
    <ListPage<B>
      embedded
      search={false}
      title={t('sites.tabs.backup')}
      description={t('sites.backupHint', { name: w.hosting_account.username })}
      queryKey={[...keyOf(w.uuid), 'backups']}
      fetch={() =>
        list('/backup-snapshots', {
          filters: { hosting_account: w.hosting_account.uuid },
        })
      }
      columns={[
        {
          id: 'taken',
          header: t('sites.takenAt'),
          accessorFn: (b) => b.taken_at,
          cell: ({ row }) => fmt.dateTime(row.original.taken_at),
        },
        {
          id: 'contents',
          header: t('sites.contents'),
          accessorFn: (b) =>
            b.contents.map((c) => t(`sites.backupContents.${c}` as never)).join(', '),
        },
        { id: 'size', header: t('sites.size'), accessorFn: (b) => fmt.mb(b.size_mb) },
        {
          id: 'verified',
          header: t('sites.verified'),
          accessorFn: (b) => (b.verified_at ? 'verified' : 'pending'),
          cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
        },
      ]}
      getRowId={(b) => b.uuid}
      empty={<p className="p-6 text-center text-base text-muted">{t('sites.noBackup')}</p>}
    />
  );
}
