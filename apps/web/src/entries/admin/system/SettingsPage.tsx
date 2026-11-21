import { useEffect, useState, type ReactNode } from 'react';
import { useForm, type DefaultValues, type FieldValues, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SystemStatusCard } from '../pages/SystemStatusCard';
import { CheckGroupField, SelectField, SwitchField, TextField } from '@/shared/page/fields';
import { DetailPage } from '@/shared/page/DetailPage';
import { FormDialog } from '@/shared/page/FormDialog';
import { InfoList } from '@/shared/page/InfoList';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { get, list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { Mono, SecretDialog } from '@/shared/hosting/pages/common';

const num = (min: number, max: number) =>
  z
    .number({ error: 'admin:packages.errors.number' })
    .int('admin:packages.errors.number')
    .min(min, `admin:packages.errors.min|${min}`)
    .max(max, `admin:packages.errors.max|${max}`);

export const generalSchema = z.object({
  panel_name: z.string().trim().min(1, 'form.required').max(60, 'form.maxLength|60'),
  default_locale: z.enum(['vi', 'en']),
  timezone: z.string().min(1, 'form.required'),
});
export const securitySchema = z.object({
  admin_mfa_required: z.literal(true, { error: 'admin:settings.errors.mfa' }),
  session_lifetime_min: num(15, 720),
  portal_captcha_after_failures: num(1, 10),
  portal_mfa_required: z.boolean(),
});
export const smtpSchema = z.object({
  host: z.string().trim().min(1, 'form.required'),
  port: num(1, 65535),
  username: z.string().trim(),
  from: z.string().trim().min(1, 'form.required'),
  encryption: z.enum(['none', 'starttls', 'tls']),
});
const TOKEN_SCOPES = [
  'servers:read',
  'accounts:read',
  'accounts:write',
  'websites:read',
  'websites:write',
  'backups:read',
] as const;
export const tokenSchema = z.object({
  name: z.string().trim().min(1, 'form.required').max(80, 'form.maxLength|80'),
  scopes: z.array(z.string()).min(1, 'admin:settings.errors.scopes'),
  days: z.enum(['30', '90', '180', '365']),
});
type TokenForm = z.infer<typeof tokenSchema>;
type Token = Row<'/api/v1/admin/api-tokens'>;

export default function SettingsPage() {
  const { t } = useTranslation('admin');
  return (
    <DetailPage
      title={t('settings.title')}
      description={t('settings.description')}
      tabs={[
        {
          value: 'general',
          label: t('settings.tabs.general'),
          content: (
            <GroupForm group="general" schema={generalSchema}>
              {(c) => (
                <>
                  <TextField control={c} name="panel_name" label={t('settings.panelName')} />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <SelectField
                      control={c}
                      name="default_locale"
                      label={t('settings.locale')}
                      options={[
                        { value: 'vi', label: 'Tiếng Việt' },
                        { value: 'en', label: 'English' },
                      ]}
                    />
                    <SelectField
                      control={c}
                      name="timezone"
                      label={t('settings.timezone')}
                      options={['Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'UTC'].map(
                        (z) => ({ value: z, label: z }),
                      )}
                    />
                  </div>
                </>
              )}
            </GroupForm>
          ),
        },
        {
          value: 'security',
          label: t('settings.tabs.security'),
          content: (
            <GroupForm
              group="security"
              schema={securitySchema}
              note={<Alert tone="info" title={t('settings.mfaLocked')} />}
            >
              {(c) => (
                <>
                  <SwitchField
                    control={c}
                    name="admin_mfa_required"
                    label={t('settings.adminMfa')}
                    description={t('settings.adminMfaHint')}
                  />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField
                      control={c}
                      name="session_lifetime_min"
                      type="number"
                      inputMode="numeric"
                      label={t('settings.session')}
                      description={t('settings.sessionHint')}
                    />
                    <TextField
                      control={c}
                      name="portal_captcha_after_failures"
                      type="number"
                      inputMode="numeric"
                      label={t('settings.captcha')}
                      description={t('settings.captchaHint')}
                    />
                  </div>
                  <SwitchField
                    control={c}
                    name="portal_mfa_required"
                    label={t('settings.portalMfa')}
                    description={t('settings.portalMfaHint')}
                  />
                </>
              )}
            </GroupForm>
          ),
        },
        {
          value: 'smtp',
          label: t('settings.tabs.smtp'),
          content: (
            <GroupForm
              group="smtp"
              schema={smtpSchema}
              note={<Alert tone="info" title={t('settings.smtpSecret')} />}
            >
              {(c) => (
                <>
                  <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
                    <TextField control={c} name="host" label={t('settings.smtpHost')} />
                    <TextField
                      control={c}
                      name="port"
                      type="number"
                      inputMode="numeric"
                      label={t('settings.smtpPort')}
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField
                      control={c}
                      name="username"
                      label={t('settings.smtpUser')}
                      autoComplete="off"
                    />
                    <SelectField
                      control={c}
                      name="encryption"
                      label={t('settings.smtpEnc')}
                      options={(['starttls', 'tls', 'none'] as const).map((e) => ({
                        value: e,
                        label: t(`settings.enc.${e}`),
                      }))}
                    />
                  </div>
                  <TextField control={c} name="from" label={t('settings.smtpFrom')} />
                </>
              )}
            </GroupForm>
          ),
        },
        { value: 'tokens', label: t('settings.tabs.tokens'), content: <TokensTab /> },
        { value: 'system', label: t('settings.tabs.system'), content: <SystemTab /> },
      ]}
    />
  );
}

/** Form cho một nhóm cài đặt: đọc GET /settings/{group}, lưu PATCH chỉ các trường đã đổi. */
function GroupForm<T extends FieldValues>({
  group,
  schema,
  note,
  children,
}: {
  group: 'general' | 'security' | 'smtp';
  schema: z.ZodType<T>;
  note?: ReactNode;
  children: (c: ReturnType<typeof useForm<T>>['control']) => ReactNode;
}) {
  const { t } = useTranslation('admin');
  const q = useQuery({
    queryKey: ['admin', 'settings', group],
    queryFn: () => get('/api/v1/admin/settings/{group}', { path: { group } }),
  });
  const { control, handleSubmit, reset, formState } = useForm<T>({
    resolver: zodResolver(schema as never) as unknown as Resolver<T>,
  });
  useEffect(() => {
    if (q.data) reset(q.data.values as DefaultValues<T>);
  }, [q.data, reset]);
  const save = useAction(
    (v: T) => {
      const cur = (q.data?.values ?? {}) as Record<string, unknown>;
      const diff = Object.fromEntries(Object.entries(v).filter(([k, x]) => cur[k] !== x));
      return send('PATCH', '/api/v1/admin/settings/{group}', { path: { group }, body: diff });
    },
    { success: t('settings.saved'), invalidate: [['admin', 'settings', group]] },
  );
  if (q.isLoading) return <PageSkeleton />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  return (
    <Card>
      <CardHeader title={t(`settings.tabs.${group}`)} description={t(`settings.hint.${group}`)} />
      <CardContent>
        <form
          noValidate
          className="flex max-w-2xl flex-col gap-4"
          onSubmit={(e) => void handleSubmit((v) => save.mutate(v))(e)}
        >
          {note}
          {children(control)}
          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending || !formState.isDirty}>
              {t('settings.save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TokensTab() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Token | null>(null);
  const q = useQuery({
    queryKey: ['admin', 'api-tokens'],
    queryFn: () => list('/api/v1/admin/api-tokens'),
  });
  const revoke = useAction(
    (tk: Token) => send('DELETE', '/api/v1/admin/api-tokens/{id}', { path: { id: tk.uuid } }),
    {
      success: t('settings.revoked'),
      invalidate: [['admin', 'api-tokens']],
      onSuccess: () => setRevoking(null),
    },
  );
  const columns: ColumnDef<Token, unknown>[] = [
    {
      id: 'name',
      header: t('settings.tokenName'),
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      id: 'scopes',
      header: t('settings.scopes'),
      accessorFn: (x) => x.scopes.join(' '),
      cell: ({ row }) => (
        <span className="flex flex-wrap gap-1">
          {row.original.scopes.map((s) => (
            <Badge key={s} tone={s.endsWith(':write') ? 'warning' : 'neutral'}>
              {s}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      id: 'used',
      header: t('settings.lastUsed'),
      accessorFn: (x) => x.last_used_at ?? '',
      cell: ({ row }) =>
        row.original.last_used_at ? fmt.rel(row.original.last_used_at) : t('users.never'),
    },
    {
      id: 'expires',
      header: t('settings.expires'),
      accessorKey: 'expires_at',
      cell: ({ row }) => fmt.date(row.original.expires_at),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger-text"
          onClick={() => setRevoking(row.original)}
          aria-label={t('settings.revokeFor', { name: row.original.name })}
        >
          {t('settings.revoke')}
        </Button>
      ),
    },
  ];
  return (
    <Card>
      <CardHeader
        title={t('settings.tokens')}
        description={t('settings.tokensHint')}
        action={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('settings.addToken')}
          </Button>
        }
      />
      <CardContent>
        <DataTable
          data={q.data ?? []}
          columns={columns}
          getRowId={(x) => x.uuid}
          primaryColumnId="name"
          caption={t('settings.tokens')}
          empty={t('settings.noTokens')}
        />
      </CardContent>
      {creating && (
        <TokenDialog
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setSecret(s);
          }}
        />
      )}
      <SecretDialog
        secret={secret}
        title={t('settings.tokenCreated')}
        onClose={() => setSecret(null)}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={t('settings.revokeTitle', { name: revoking?.name ?? '' })}
        description={t('settings.revokeHint')}
        confirmLabel={t('settings.revoke')}
        onConfirm={() =>
          revoking ? revoke.mutateAsync(revoking).then(() => undefined) : undefined
        }
      />
    </Card>
  );
}

function TokenDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit } = useForm<TokenForm>({
    resolver: zodResolver(tokenSchema),
    defaultValues: { name: '', scopes: [], days: '90' },
  });
  const create = useAction(
    (v: TokenForm) =>
      send<{ secret: string }>('POST', '/api/v1/admin/api-tokens', {
        body: {
          name: v.name,
          scopes: v.scopes,
          expires_at: new Date(Date.now() + Number(v.days) * 86_400_000).toISOString(),
        },
      }),
    { invalidate: [['admin', 'api-tokens']], onSuccess: (r) => onCreated(r.secret) },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('settings.addToken')}
      description={t('settings.addTokenHint')}
      submitLabel={t('settings.createToken')}
      pending={create.isPending}
      onSubmit={() => void handleSubmit((v) => create.mutate(v))()}
    >
      <TextField control={control} name="name" label={t('settings.tokenName')} />
      <CheckGroupField
        control={control}
        name="scopes"
        label={t('settings.scopes')}
        options={TOKEN_SCOPES.map((s) => ({ value: s, label: s }))}
      />
      <SelectField
        control={control}
        name="days"
        label={t('settings.expires')}
        options={(['30', '90', '180', '365'] as const).map((d) => ({
          value: d,
          label: t('settings.days', { count: Number(d) }),
        }))}
      />
    </FormDialog>
  );
}

function SystemTab() {
  const { t } = useTranslation('admin');
  const v = useQuery({
    queryKey: ['admin', 'system', 'version'],
    queryFn: () => get('/api/v1/admin/system/version'),
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title={t('settings.version')} />
        <CardContent>
          {v.data && (
            <InfoList
              items={[
                [t('settings.panelVersion'), <Mono key="v">{v.data.version}</Mono>],
                [t('settings.commit'), <Mono key="c">{v.data.commit}</Mono>],
                [t('settings.agentMin'), <Mono key="a">{v.data.agent_min_version}</Mono>],
                [
                  t('settings.update'),
                  v.data.update_available ? (
                    <Badge key="u" tone="info">
                      {v.data.update_available}
                    </Badge>
                  ) : (
                    <Badge key="u" tone="success">
                      {t('settings.upToDate')}
                    </Badge>
                  ),
                ],
              ]}
            />
          )}
          <p className="mt-3 flex items-center gap-2 text-sm text-muted">
            <KeyRound aria-hidden className="size-4" />
            {t('settings.updateNote')}
          </p>
        </CardContent>
      </Card>
      <SystemStatusCard />
    </div>
  );
}
