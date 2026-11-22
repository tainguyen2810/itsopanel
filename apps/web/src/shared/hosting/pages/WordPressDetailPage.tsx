import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, RefreshCw, ShieldCheck, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { DetailPage } from '@/shared/page/DetailPage';
import { FormDialog } from '@/shared/page/FormDialog';
import { InfoList } from '@/shared/page/InfoList';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { useCrumbName } from '@/shared/routing/crumbs';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Checkbox, Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Skeleton } from '@/ui/Feedback';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { get, list, send, type Data, type Row } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { useRealmLinks, useRouteId } from './common';

type Detail = Data<'/wordpress/sites/{id}'>;
type Site = Detail['site'];
type Component = Detail['components'][number];
type Update = Row<'/wordpress/sites/{id}/updates'>;

/** Các mục hardening (D-99), theo thứ tự hiển thị. `salts_rotated` là thao tác một chiều. */
export const HARDENING = [
  'file_edit_disabled',
  'xmlrpc_blocked',
  'php_in_uploads_blocked',
  'wp_config_protected',
  'version_hidden',
  'salts_rotated',
] as const;
export const WINDOWS = ['00:00-03:00', '01:00-04:00', '02:00-05:00', '03:00-06:00', '22:00-01:00'];
const STEPS = ['snapshot', 'maintenance', 'update', 'verify', 'rollback'] as const;

/** Thành phần có bản mới (chọn được để cập nhật). */
export const isOutdated = (c: Pick<Component, 'version' | 'latest_version'>) =>
  c.latest_version !== null && c.latest_version !== c.version;

/** Body cập nhật từ lựa chọn: `core` + slug plugin/theme. */
export function updateBody(sel: ReadonlySet<string>) {
  const pick = (type: 'plugin' | 'theme') =>
    [...sel].filter((k) => k.startsWith(`${type}:`)).map((k) => k.slice(type.length + 1));
  return { core: sel.has('core'), plugins: pick('plugin'), themes: pick('theme') };
}

const keyOf = (id: string) => ['wordpress', id];

export default function WordPressDetailPage() {
  const { t } = useTranslation('admin');
  const id = useRouteId();
  const links = useRealmLinks();
  const q = useQuery({
    queryKey: keyOf(id),
    queryFn: () => get('/wordpress/sites/{id}', { path: { id } }),
  });
  useCrumbName(id, q.data?.site.website.primary_domain);
  const [dialog, setDialog] = useState<'password' | 'staging' | null>(null);
  const maint = useAction(
    (enabled: boolean) =>
      send('POST', '/wordpress/sites/{id}:maintenance', { path: { id }, body: { enabled } }),
    { invalidate: [keyOf(id)] },
  );
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) {
    return (
      <>
        <PageHeader title={t('wp.detail')} />
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  }
  const d = q.data;
  const s = d.site;
  const pending = (isOutdated(d.core) ? 1 : 0) + d.components.filter((c) => isOutdated(c)).length;
  return (
    <>
      <DetailPage
        title={s.website.primary_domain}
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={s.state} />
            {s.maintenance && <Badge tone="warning">{t('wp.maintenanceOn')}</Badge>}
            {s.staging_of && <Badge tone="info">staging</Badge>}
          </span>
        }
        description={
          <>
            WordPress {s.wp_version} ·{' '}
            <AppLink href={links.account(s.hosting_account.uuid)} className="hover:underline">
              {s.hosting_account.username}
            </AppLink>
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setDialog('password')}>
              <KeyRound aria-hidden />
              {t('wp.adminPassword')}
            </Button>
            {s.staging_of === null && (
              <Button variant="outline" onClick={() => setDialog('staging')}>
                <Copy aria-hidden />
                {t('wp.staging')}
              </Button>
            )}
          </>
        }
        tabs={[
          {
            value: 'overview',
            label: t('wp.tabs.overview'),
            content: (
              <Overview
                d={d}
                pending={pending}
                maintPending={maint.isPending}
                onMaintenance={(v) => maint.mutate(v)}
              />
            ),
          },
          {
            value: 'updates',
            label: pending > 0 ? `${t('wp.tabs.updates')} (${pending})` : t('wp.tabs.updates'),
            content: <Updates d={d} />,
          },
          { value: 'security', label: t('wp.tabs.security'), content: <Security s={s} /> },
        ]}
      />
      <PasswordDialog
        site={s}
        open={dialog === 'password'}
        onOpenChange={(o) => setDialog(o ? 'password' : null)}
      />
      <StagingDialog
        site={s}
        open={dialog === 'staging'}
        onOpenChange={(o) => setDialog(o ? 'staging' : null)}
      />
    </>
  );
}

function Overview({
  d,
  pending,
  maintPending,
  onMaintenance,
}: {
  d: Detail;
  pending: number;
  maintPending: boolean;
  onMaintenance: (v: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const links = useRealmLinks();
  const s = d.site;
  const [auto, setAuto] = useState(s.auto_update);
  const [win, setWin] = useState(s.update_window);
  const save = useAction(
    () =>
      send('PATCH', '/wordpress/sites/{id}', {
        path: { id: s.uuid },
        body: { auto_update: auto, update_window: win },
      }),
    { invalidate: [keyOf(s.uuid), ['admin', 'wordpress']], success: t('wp.settingsSaved') },
  );
  const dirty = auto !== s.auto_update || win !== s.update_window;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {s.last_update?.state === 'rolled_back' && (
        <Alert tone="warning" title={t('wp.lastRolledBack')} className="lg:col-span-2">
          {t('wp.lastRolledBackHint', { at: fmt.dateTime(s.last_update.at) })}
        </Alert>
      )}
      <Card>
        <CardHeader title={t('wp.info')} />
        <CardContent>
          <InfoList
            items={[
              [
                t('wp.core'),
                <span key="core" className="flex flex-wrap items-center gap-1.5">
                  {d.core.version}
                  {isOutdated(d.core) && (
                    <Badge tone="warning">{t('wp.newVersion', { v: d.core.latest_version })}</Badge>
                  )}
                  {d.core.checksums_ok === false && (
                    <Badge tone="danger">{t('wp.checksumsBad')}</Badge>
                  )}
                </span>,
              ],
              [t('wp.php'), s.php_version ?? '—'],
              [
                t('wp.adminUser'),
                <span key="u" className="font-mono">
                  {s.admin_username ?? '—'}
                </span>,
              ],
              [
                t('wp.updates'),
                pending === 0 ? (
                  <Badge key="p" tone="success">
                    {t('wp.upToDate')}
                  </Badge>
                ) : (
                  <Badge key="p" tone="warning">
                    {t('wp.pending', { count: pending })}
                  </Badge>
                ),
              ],
              [
                t('wp.hardening'),
                `${HARDENING.filter((k) => s.hardening[k]).length}/${HARDENING.length}`,
              ],
              [
                t('wp.website'),
                <AppLink key="w" href={links.website(s.website.uuid)} className="hover:underline">
                  {s.website.primary_domain}
                </AppLink>,
              ],
            ]}
          />
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title={t('wp.maintenance')}
            description={t('wp.maintenanceHint')}
            action={
              <Switch
                checked={s.maintenance}
                disabled={maintPending}
                onCheckedChange={onMaintenance}
                aria-label={t('wp.maintenance')}
              />
            }
          />
        </Card>
        <Card>
          <CardHeader title={t('wp.autoUpdate')} description={t('wp.autoUpdateHint')} />
          <CardContent className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wp-auto">{t('wp.autoPolicy')}</Label>
                <Select
                  id="wp-auto"
                  value={auto}
                  onValueChange={(v) => setAuto(v as Site['auto_update'])}
                  options={(['off', 'minor', 'all'] as const).map((k) => ({
                    value: k,
                    label: t(`wp.autoLong.${k}`),
                  }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wp-win">{t('wp.window')}</Label>
                <Select
                  id="wp-win"
                  value={win}
                  disabled={auto === 'off'}
                  onValueChange={setWin}
                  options={[...new Set([win, ...WINDOWS])].map((w) => ({ value: w, label: w }))}
                />
              </div>
            </div>
            <p className="text-sm text-muted">{t('wp.autoSafety')}</p>
            <div className="flex justify-end">
              <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                {t('wp.saveSettings')}
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader title={t('wp.stagingSites')} />
          <CardContent>
            {d.staging.length === 0 ? (
              <p className="text-sm text-muted">{t('wp.noStaging')}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-base">
                {d.staging.map((x) => (
                  <li key={x.uuid} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono break-all">{x.domain}</span>
                    <span className="text-sm text-muted">{fmt.rel(x.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Updates({ d }: { d: Detail }) {
  const { t } = useTranslation('admin');
  const s = d.site;
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const run = useAction(
    () =>
      send('POST', '/wordpress/sites/{id}:update', { path: { id: s.uuid }, body: updateBody(sel) }),
    {
      invalidate: [keyOf(s.uuid), ['wordpress', s.uuid, 'updates'], ['admin', 'wordpress']],
      onSuccess: () => {
        setConfirm(false);
        setSel(new Set());
      },
    },
  );
  const outdatedKeys = [
    ...(isOutdated(d.core) ? ['core'] : []),
    ...d.components.filter((c) => isOutdated(c)).map((c) => `${c.type}:${c.slug}`),
  ];
  const toggle = (k: string, on: boolean) => {
    const n = new Set(sel);
    if (on) n.add(k);
    else n.delete(k);
    setSel(n);
  };
  const busy = s.state === 'updating';
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title={t('wp.components')}
          description={t('wp.componentsHint')}
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={outdatedKeys.length === 0}
                onClick={() => setSel(new Set(outdatedKeys))}
              >
                {t('wp.selectOutdated')}
              </Button>
              <Button size="sm" disabled={sel.size === 0 || busy} onClick={() => setConfirm(true)}>
                <RefreshCw aria-hidden />
                {t('wp.updateSelected', { count: sel.size })}
              </Button>
            </div>
          }
        />
        <CardContent>
          {busy && <Alert tone="info" title={t('wp.updating')} className="mb-3" />}
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            <ComponentRow
              k="core"
              name="WordPress"
              type={t('wp.core')}
              version={d.core.version}
              latest={d.core.latest_version}
              active
              checked={sel.has('core')}
              onCheck={toggle}
            />
            {d.components.map((c) => (
              <ComponentRow
                key={`${c.type}:${c.slug}`}
                k={`${c.type}:${c.slug}`}
                name={c.name}
                type={t(`wp.type.${c.type}`)}
                version={c.version}
                latest={c.latest_version}
                active={c.active}
                auto={c.auto_update}
                checked={sel.has(`${c.type}:${c.slug}`)}
                onCheck={toggle}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
      <History site={s} />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        tone="primary"
        title={t('wp.confirmSelected', { count: sel.size, name: s.website.primary_domain })}
        description={t('wp.confirmSelectedHint')}
        confirmLabel={t('wp.confirmLabel.update')}
        onConfirm={() => run.mutateAsync().then(() => undefined)}
      />
    </div>
  );
}

function ComponentRow({
  k,
  name,
  type,
  version,
  latest,
  active,
  auto,
  checked,
  onCheck,
}: {
  k: string;
  name: string;
  type: string;
  version: string;
  latest: string | null;
  active: boolean;
  auto?: boolean;
  checked: boolean;
  onCheck: (k: string, on: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const can = isOutdated({ version, latest_version: latest });
  const id = `wp-c-${k.replace(/[^a-z0-9-]/gi, '-')}`;
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={!can}
        onCheckedChange={(v) => onCheck(k, v === true)}
        aria-label={t('wp.selectComponent', { name })}
      />
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-1.5 font-medium">
          {name}
          <Badge tone="neutral">{type}</Badge>
          {!active && <span className="text-sm font-normal text-muted">{t('wp.inactive')}</span>}
          {auto && <span className="text-sm font-normal text-muted">{t('wp.autoOn')}</span>}
        </span>
      </label>
      <span className="text-sm tabular-nums">
        {can ? (
          <>
            {version} → <span className="font-medium text-warning-text">{latest}</span>
          </>
        ) : (
          <>
            {version}
            {latest === null && <span className="ml-1.5 text-muted">{t('wp.notInRepo')}</span>}
          </>
        )}
      </span>
    </li>
  );
}

function History({ site }: { site: Site }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['wordpress', site.uuid, 'updates'],
    queryFn: () => list('/wordpress/sites/{id}/updates', undefined, { path: { id: site.uuid } }),
  });
  return (
    <Card>
      <CardHeader title={t('wp.history')} description={t('wp.historyHint')} />
      <CardContent>
        {q.isPending ? (
          <Skeleton className="h-24" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <p className="text-sm text-muted">{t('wp.noHistory')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {q.data.map((u: Update) => (
              <li key={u.uuid} className="flex flex-col gap-2 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={u.state} />
                    <Badge tone="neutral">{t(`wp.trigger.${u.trigger}`)}</Badge>
                    <span className="text-sm text-muted">
                      {fmt.dateTime(u.started_at)}
                      {u.requested_by ? ` · ${u.requested_by.name}` : ''}
                    </span>
                  </span>
                </div>
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {u.items.map((i) => (
                    <li key={`${i.type}:${i.slug}`}>
                      <span className="font-medium">{i.slug}</span>{' '}
                      <span className="text-muted tabular-nums">
                        {i.from} → {i.to}
                      </span>
                    </li>
                  ))}
                </ul>
                <ol className="flex flex-wrap gap-1.5" aria-label={t('wp.steps')}>
                  {STEPS.map((k) => {
                    const st = u.steps.find((x) => x.key === k)?.state ?? 'pending';
                    return (
                      <li key={k}>
                        <Badge
                          tone={
                            st === 'done'
                              ? 'success'
                              : st === 'failed'
                                ? 'danger'
                                : st === 'running'
                                  ? 'info'
                                  : 'neutral'
                          }
                        >
                          {t(`wp.step.${k}`)}
                          <span className="sr-only">: {t(`wp.stepState.${st}`)}</span>
                        </Badge>
                      </li>
                    );
                  })}
                </ol>
                {u.error && <p className="text-sm text-danger-text">{u.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Security({ s }: { s: Site }) {
  const { t } = useTranslation('admin');
  const harden = useAction(
    (v: { items: (typeof HARDENING)[number][]; enabled: boolean }) =>
      send('POST', '/wordpress/sites/{id}:harden', { path: { id: s.uuid }, body: v }),
    { invalidate: [keyOf(s.uuid), ['admin', 'wordpress']] },
  );
  const missing = HARDENING.filter((k) => !s.hardening[k] && k !== 'salts_rotated');
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck aria-hidden className="size-4" />
            {t('wp.hardening')}
          </span>
        }
        description={t('wp.hardeningHint')}
        action={
          <Button
            size="sm"
            disabled={missing.length === 0 || harden.isPending}
            onClick={() => harden.mutate({ items: missing, enabled: true })}
          >
            <Wrench aria-hidden />
            {t('wp.hardenAll')}
          </Button>
        }
      />
      <CardContent>
        <ul className="flex flex-col divide-y divide-border">
          {HARDENING.map((k) => (
            <li key={k} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="font-medium">{t(`wp.hd.${k}.title`)}</p>
                <p className="text-sm text-muted">{t(`wp.hd.${k}.hint`)}</p>
              </div>
              {k === 'salts_rotated' ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={harden.isPending}
                  onClick={() => harden.mutate({ items: [k], enabled: true })}
                >
                  {t('wp.rotateSalts')}
                </Button>
              ) : (
                <Switch
                  checked={s.hardening[k] === true}
                  disabled={harden.isPending}
                  onCheckedChange={(v) => harden.mutate({ items: [k], enabled: v })}
                  aria-label={t(`wp.hd.${k}.title`)}
                />
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function PasswordDialog({
  site,
  open,
  onOpenChange,
}: {
  site: Site;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const [pw, setPw] = useState('');
  const close = (o: boolean) => {
    if (!o) setPw('');
    onOpenChange(o);
  };
  const valid = /^[A-Za-z0-9._~!@#%^*+=:,-]{12,128}$/.test(pw);
  const run = useAction(
    () =>
      send('POST', '/wordpress/sites/{id}:admin-password', {
        path: { id: site.uuid },
        body: { password: pw },
      }),
    { onSuccess: () => close(false) },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t('wp.adminPasswordTitle', { user: site.admin_username ?? 'admin' })}
      description={t('wp.adminPasswordHint')}
      submitLabel={t('wp.adminPasswordSubmit')}
      pending={run.isPending}
      submitDisabled={!valid}
      onSubmit={() => run.mutate()}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wp-pw">{t('wp.newPassword')}</Label>
        <Input
          id="wp-pw"
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          aria-describedby="wp-pw-hint"
          aria-invalid={pw !== '' && !valid}
        />
        <p id="wp-pw-hint" className="text-sm text-muted">
          {t('wp.passwordRule')}
        </p>
      </div>
    </FormDialog>
  );
}

function StagingDialog({
  site,
  open,
  onOpenChange,
}: {
  site: Site;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const [sub, setSub] = useState('staging');
  const [noindex, setNoindex] = useState(true);
  const valid = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/.test(sub);
  const run = useAction(
    () =>
      send('POST', '/wordpress/sites/{id}:clone-staging', {
        path: { id: site.uuid },
        body: { subdomain: sub, noindex },
      }),
    {
      invalidate: [keyOf(site.uuid), ['admin', 'wordpress']],
      onSuccess: () => onOpenChange(false),
    },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('wp.stagingTitle', { name: site.website.primary_domain })}
      description={t('wp.stagingHint')}
      submitLabel={t('wp.confirmLabel.clone-staging')}
      pending={run.isPending}
      submitDisabled={!valid}
      onSubmit={() => run.mutate()}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wp-sub">{t('wp.subdomain')}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            id="wp-sub"
            value={sub}
            onChange={(e) => setSub(e.target.value.toLowerCase())}
            aria-invalid={!valid}
            className="max-w-48"
          />
          <span className="text-base break-all text-muted">.{site.website.primary_domain}</span>
        </div>
      </div>
      {/* Basic auth cho staging chưa có ở bản này (API trả 422): hiện tắt, kèm lý do. */}
      <div className="flex flex-col gap-1">
        <label className="flex items-center justify-between gap-3 text-base text-muted">
          {t('wp.basicAuth')}
          <Switch
            checked={false}
            disabled
            aria-label={t('wp.basicAuth')}
            aria-describedby="wp-auth-later"
          />
        </label>
        <p id="wp-auth-later" className="text-sm text-muted">
          {t('wp.basicAuthLater')}
        </p>
      </div>
      <label className="flex items-center justify-between gap-3 text-base">
        {t('wp.noindex')}
        <Switch checked={noindex} onCheckedChange={setNoindex} aria-label={t('wp.noindex')} />
      </label>
      <p className="text-sm text-muted">{t('wp.stagingQuota')}</p>
    </FormDialog>
  );
}
