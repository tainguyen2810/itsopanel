import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, ScanSearch } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { list, send, type Row } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { RowMenu, SecretDialog, useAccountFilter, useRealmLinks, useWebsites } from './common';
import { wpInstallSchema, type WpInstallForm } from './forms';

type Wp = Row<'/wordpress/sites'>;
import { HARDENING } from './WordPressDetailPage';

type Action = 'update';

export default function WordPressPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const accountFilter = useAccountFilter();
  const links = useRealmLinks();
  const navigate = useNavigate();
  const [installing, setInstalling] = useState(false);
  const [confirm, setConfirm] = useState<{ wp: Wp; action: Action } | null>(null);
  const act = useAction(
    ({ wp, action }: { wp: Wp; action: Action }) =>
      send('POST', `/wordpress/sites/{id}:${action}` as '/wordpress/sites/{id}:update', {
        path: { id: wp.uuid },
        body: {},
      }),
    { onSuccess: () => setConfirm(null), invalidate: [['admin', 'wordpress']] },
  );
  const scan = useAction(() => send('POST', '/wordpress/sites:scan'), {
    invalidate: [['admin', 'wordpress']],
  });
  const outdated = (w: Wp) =>
    (w.wp_version !== w.latest_version ? 1 : 0) + w.plugins_outdated + w.themes_outdated;
  const columns: ColumnDef<Wp, unknown>[] = [
    {
      id: 'site',
      header: t('wp.site'),
      accessorFn: (w) => w.website.primary_domain,
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`${links.base}/wordpress/${row.original.uuid}`}
            className="font-medium break-all hover:underline"
          >
            {row.original.website.primary_domain}
          </AppLink>
          <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
            {row.original.hosting_account.username}
            {row.original.staging_of && <Badge tone="info">staging</Badge>}
            {row.original.maintenance && <Badge tone="warning">{t('wp.maintenanceOn')}</Badge>}
          </p>
        </div>
      ),
    },
    {
      id: 'state',
      header: t('wp.state'),
      accessorKey: 'state',
      cell: ({ row }) => <StatusBadge status={row.original.state} />,
    },
    {
      id: 'version',
      header: t('wp.version'),
      accessorKey: 'wp_version',
      cell: ({ row }) =>
        row.original.wp_version === row.original.latest_version ? (
          <span>{row.original.wp_version}</span>
        ) : (
          <span className="flex flex-col">
            <span>{row.original.wp_version}</span>
            <span className="text-xs text-warning-text">
              {t('wp.newVersion', { v: row.original.latest_version })}
            </span>
          </span>
        ),
    },
    {
      id: 'plugins',
      header: t('wp.plugins'),
      accessorFn: (w) => w.plugins_outdated,
      cell: ({ row }) => (
        <span className="text-sm">
          {t('wp.pluginsValue', {
            total: row.original.plugins_total,
            outdated: row.original.plugins_outdated,
          })}
        </span>
      ),
    },
    {
      id: 'updates',
      header: t('wp.updates'),
      accessorFn: outdated,
      cell: ({ row }) => {
        const n = outdated(row.original);
        return n === 0 ? (
          <Badge tone="success">{t('wp.upToDate')}</Badge>
        ) : (
          <Badge tone="warning">{t('wp.pending', { count: n })}</Badge>
        );
      },
    },
    {
      id: 'hardening',
      header: t('wp.hardening'),
      accessorFn: (w) => HARDENING.filter((k) => w.hardening[k]).length,
      cell: ({ getValue }) => (
        <span className="text-sm tabular-nums">
          {getValue<number>()}/{HARDENING.length}
        </span>
      ),
    },
    {
      id: 'auto',
      header: t('wp.autoUpdate'),
      accessorFn: (w) => t(`wp.auto.${w.auto_update}`),
      cell: ({ row }) => (
        <span className="flex flex-col text-sm">
          <span>{t(`wp.auto.${row.original.auto_update}`)}</span>
          {row.original.auto_update !== 'off' && (
            <span className="text-xs text-muted tabular-nums">{row.original.update_window}</span>
          )}
        </span>
      ),
    },
    {
      id: 'last',
      header: t('wp.lastUpdate'),
      accessorFn: (w) => w.last_update?.at ?? '',
      cell: ({ row }) =>
        row.original.last_update ? (
          <span className="flex flex-col gap-0.5">
            <StatusBadge status={row.original.last_update.state} />
            <span className="text-xs text-muted">{fmt.rel(row.original.last_update.at)}</span>
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('wp.actionsFor', { name: row.original.website.primary_domain })}
          actions={[
            {
              label: t('wp.update'),
              onSelect: () => setConfirm({ wp: row.original, action: 'update' }),
              hidden: outdated(row.original) === 0,
            },
            {
              label: t('wp.open'),
              onSelect: () => void navigate({ to: `/wordpress/${row.original.uuid}` }),
            },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Wp>
        title={t('wp.title')}
        description={t('wp.description')}
        actions={
          <>
            <Button variant="outline" disabled={scan.isPending} onClick={() => scan.mutate()}>
              <ScanSearch aria-hidden />
              {t('wp.scan')}
            </Button>
            <Button onClick={() => setInstalling(true)}>
              <Plus aria-hidden />
              {t('wp.install')}
            </Button>
          </>
        }
        queryKey={['admin', 'wordpress']}
        fetch={(q) => list('/wordpress/sites', q)}
        filters={[accountFilter]}
        columns={columns}
        getRowId={(w) => w.uuid}
        primaryColumnId="site"
      />
      <Install open={installing} onOpenChange={setInstalling} />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        tone="primary"
        title={confirm ? t('wp.confirm.update', { name: confirm.wp.website.primary_domain }) : ''}
        description={t('wp.confirmHint.update')}
        confirmLabel={t('wp.confirmLabel.update')}
        onConfirm={() => (confirm ? act.mutateAsync(confirm).then(() => undefined) : undefined)}
      />
    </>
  );
}

function Install({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('admin');
  const { sites } = useWebsites(undefined, open);
  const empty: WpInstallForm = {
    website_uuid: '',
    title: '',
    admin_username: '',
    admin_email: '',
    locale: 'vi',
  };
  const { control, handleSubmit, reset } = useForm<WpInstallForm>({
    resolver: zodResolver(wpInstallSchema),
    defaultValues: empty,
  });
  const [secret, setSecret] = useState<string | null>(null);
  const close = (o: boolean) => {
    if (!o) reset(empty);
    onOpenChange(o);
  };
  // Mật khẩu quản trị do panel sinh, API trả MỘT lần trong `secret` (không lưu, không có trong job).
  const install = useAction(
    (v: WpInstallForm) => send<{ secret?: string }>('POST', '/wordpress/sites', { body: v }),
    {
      invalidate: [['admin', 'wordpress']],
      onSuccess: (r) => {
        close(false);
        if (r.secret) setSecret(r.secret);
      },
    },
  );
  return (
    <>
      <SecretDialog
        secret={secret}
        title={t('wp.adminPasswordOnce')}
        onClose={() => setSecret(null)}
      />
      <FormDialog
        open={open}
        onOpenChange={close}
        title={t('wp.installTitle')}
        description={t('wp.installHint')}
        submitLabel={t('wp.install')}
        pending={install.isPending}
        onSubmit={() => void handleSubmit((v) => install.mutate(v))()}
      >
        <SelectField
          control={control}
          name="website_uuid"
          label={t('wp.site')}
          options={sites
            .filter((w) => w.type === 'php')
            .map((w) => ({
              value: w.uuid,
              label: `${w.primary_domain} (${w.hosting_account.username})`,
            }))}
          placeholder={t('wp.pickSite')}
          description={t('wp.phpOnly')}
        />
        <TextField control={control} name="title" label={t('wp.siteTitle')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            control={control}
            name="admin_username"
            label={t('wp.adminUser')}
            description={t('wp.adminUserHint')}
            autoComplete="off"
          />
          <TextField control={control} name="admin_email" type="email" label={t('wp.adminEmail')} />
        </div>
        <SelectField
          control={control}
          name="locale"
          label={t('wp.locale')}
          options={[
            { value: 'vi', label: 'Tiếng Việt' },
            { value: 'en_US', label: 'English (US)' },
          ]}
        />
      </FormDialog>
    </>
  );
}
