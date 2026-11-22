import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus } from 'lucide-react';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, SwitchField, TextField, TextareaField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { Alert as Callout } from '@/ui/Alert';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Switch } from '@/ui/Checkbox';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { type ColumnDef } from '@/ui/DataTable';
import { RowMenu } from '@/shared/hosting/pages/common';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';
import { MonitoringNav } from './MonitoringPage';

type Channel = Row<'/api/v1/admin/notification-channels'>;
type Delivery = { state: string; error: string | null };
const TYPES = ['email', 'telegram', 'webhook'] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const splitEmails = (s: string) =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Kiểm phía client như API (D-103); SSRF guard thật ở API khi gửi. */
export const channelSchema = (editing: boolean) =>
  z
    .object({
      type: z.enum(TYPES),
      name: z.string().trim().min(1, 'form.required').max(80, 'form.maxLength|80'),
      recipients: z.string(),
      chat_id: z.string().trim(),
      url: z.string().trim().max(500, 'form.maxLength|500'),
      allow_private_network: z.boolean(),
      secret: z.string(),
      enabled: z.boolean(),
    })
    .superRefine((v, ctx) => {
      const need = (path: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: [path], message });
      if (v.type === 'email') {
        const list = splitEmails(v.recipients);
        if (list.length === 0 || list.length > 20 || !list.every((e) => EMAIL.test(e)))
          need('recipients', 'admin:channels.errors.recipients');
      }
      if (v.type === 'telegram' && !/^-?[0-9]{1,20}$|^@[A-Za-z0-9_]{5,32}$/.test(v.chat_id))
        need('chat_id', 'admin:channels.errors.chatId');
      if (v.type === 'webhook') {
        if (!/^https:\/\//.test(v.url) && !(v.allow_private_network && /^http:\/\//.test(v.url)))
          need('url', 'admin:channels.errors.url');
      }
      if (v.type !== 'email' && !editing && v.secret.length < 16)
        need('secret', 'admin:channels.errors.secret');
      if (v.secret !== '' && (v.secret.length < 16 || v.secret.length > 512))
        need('secret', 'admin:channels.errors.secret');
    });
type Form = z.infer<ReturnType<typeof channelSchema>>;

export default function ChannelsPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [tested, setTested] = useState<{ name: string; d: Delivery } | null>(null);
  const inv = { invalidate: [['admin', 'channels']] as unknown[][] };
  const toggle = useAction(
    (c: Channel) =>
      send('PATCH', '/api/v1/admin/notification-channels/{id}', {
        path: { id: c.uuid },
        body: { enabled: !c.enabled },
      }),
    inv,
  );
  const test = useAction(
    (c: Channel) =>
      send<Delivery>('POST', '/api/v1/admin/notification-channels/{id}:test', {
        path: { id: c.uuid },
      }).then((d) => ({ name: c.name, d })),
    {
      invalidate: [
        ['admin', 'channels'],
        ['admin', 'deliveries'],
      ],
      onSuccess: setTested,
    },
  );
  const remove = useAction(
    (c: Channel) =>
      send('DELETE', '/api/v1/admin/notification-channels/{id}', { path: { id: c.uuid } }),
    { ...inv, success: t('channels.deleted'), onSuccess: () => setDeleting(null) },
  );
  const target = (c: Channel) =>
    c.type === 'email'
      ? (c.config.recipients ?? []).join(', ')
      : c.type === 'telegram'
        ? c.config.chat_id
        : c.config.url;
  const columns: ColumnDef<Channel, unknown>[] = [
    {
      id: 'name',
      header: t('channels.name'),
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {row.original.name}
            <Badge tone="neutral">{t(`alerts.channel.${row.original.type}`)}</Badge>
            {row.original.config.allow_private_network && (
              <Badge tone="warning">{t('channels.privateNet')}</Badge>
            )}
          </p>
          <p className="text-sm break-all text-muted">{target(row.original)}</p>
        </div>
      ),
    },
    {
      id: 'secret',
      header: t('channels.secret'),
      accessorFn: (c) => (c.secret_set ? 1 : 0),
      cell: ({ row }) =>
        row.original.type === 'email'
          ? '—'
          : row.original.secret_set
            ? t('channels.secretSet')
            : t('channels.secretMissing'),
    },
    {
      id: 'last',
      header: t('channels.last'),
      accessorFn: (c) => c.last_delivery?.at ?? '',
      cell: ({ row }) => {
        const d = row.original.last_delivery;
        return d ? (
          <span className="flex flex-col items-start gap-0.5">
            <StatusBadge status={d.state} />
            <span className="text-xs text-muted">{fmt.rel(d.at)}</span>
            {d.error && <span className="text-xs break-all text-danger-text">{d.error}</span>}
          </span>
        ) : (
          '—'
        );
      },
    },
    {
      id: 'enabled',
      header: t('alerts.enabled'),
      accessorFn: (c) => (c.enabled ? 1 : 0),
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          disabled={toggle.isPending}
          onCheckedChange={() => toggle.mutate(row.original)}
          aria-label={t('channels.toggle', { name: row.original.name })}
        />
      ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('channels.actionsFor', { name: row.original.name })}
          actions={[
            { label: t('channels.test'), onSelect: () => test.mutate(row.original) },
            { label: t('alerts.edit'), onSelect: () => setEditing(row.original) },
            { label: t('alerts.delete'), onSelect: () => setDeleting(row.original), danger: true },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Channel>
        title={t('channels.title')}
        description={t('channels.description')}
        nav={<MonitoringNav current="channels" />}
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('channels.add')}
          </Button>
        }
        queryKey={['admin', 'channels']}
        fetch={(q) => list('/api/v1/admin/notification-channels', q)}
        columns={columns}
        getRowId={(c) => c.uuid}
        primaryColumnId="name"
      >
        {tested && (
          <Callout
            className="mb-4"
            tone={tested.d.state === 'sent' ? 'success' : 'danger'}
            title={t(`channels.testResult.${tested.d.state === 'sent' ? 'ok' : 'fail'}`, {
              name: tested.name,
            })}
            action={
              <Button variant="ghost" size="sm" onClick={() => setTested(null)}>
                {t('channels.dismiss')}
              </Button>
            }
          >
            {tested.d.error ?? t('channels.testOkHint')}
          </Callout>
        )}
      </ListPage>
      {editing && (
        <ChannelDialog
          channel={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('channels.deleteTitle', { name: deleting?.name ?? '' })}
        description={t('channels.deleteHint')}
        confirmLabel={t('alerts.delete')}
        onConfirm={() =>
          deleting ? remove.mutateAsync(deleting).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function ChannelDialog({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit } = useForm<Form>({
    resolver: zodResolver(channelSchema(channel !== null)),
    defaultValues: {
      type: channel?.type ?? 'webhook',
      name: channel?.name ?? '',
      recipients: (channel?.config.recipients ?? []).join(', '),
      chat_id: channel?.config.chat_id ?? '',
      url: channel?.config.url ?? '',
      allow_private_network: channel?.config.allow_private_network ?? false,
      secret: '',
      enabled: channel?.enabled ?? true,
    },
  });
  const type = useWatch({ control, name: 'type' });
  const priv = useWatch({ control, name: 'allow_private_network' });
  const save = useAction(
    (v: Form) => {
      const config = {
        recipients: v.type === 'email' ? splitEmails(v.recipients) : [],
        chat_id: v.type === 'telegram' ? v.chat_id : null,
        url: v.type === 'webhook' ? v.url : null,
        allow_private_network: v.type === 'webhook' && v.allow_private_network,
      };
      const secret = v.secret === '' ? {} : { secret: v.secret };
      return channel
        ? send('PATCH', '/api/v1/admin/notification-channels/{id}', {
            path: { id: channel.uuid },
            body: { name: v.name, enabled: v.enabled, config, ...secret },
          })
        : send('POST', '/api/v1/admin/notification-channels', {
            body: { type: v.type, name: v.name, enabled: v.enabled, config, ...secret },
          });
    },
    { success: t('channels.saved'), invalidate: [['admin', 'channels']], onSuccess: onClose },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={channel ? t('channels.editTitle', { name: channel.name }) : t('channels.add')}
      description={t('channels.formHint')}
      submitLabel={t('alerts.save')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="type"
          label={t('channels.type')}
          disabled={channel !== null}
          options={TYPES.map((x) => ({ value: x, label: t(`alerts.channel.${x}`) }))}
        />
        <TextField control={control} name="name" label={t('channels.name')} />
      </div>
      {type === 'email' && (
        <TextareaField
          control={control}
          name="recipients"
          label={t('channels.recipients')}
          description={t('channels.recipientsHint')}
          rows={2}
        />
      )}
      {type === 'telegram' && (
        <TextField
          control={control}
          name="chat_id"
          label={t('channels.chatId')}
          description={t('channels.chatIdHint')}
        />
      )}
      {type === 'webhook' && (
        <>
          <TextField
            control={control}
            name="url"
            type="url"
            label={t('channels.url')}
            description={t('channels.urlHint')}
          />
          <SwitchField
            control={control}
            name="allow_private_network"
            label={t('channels.allowPrivate')}
            description={t('channels.allowPrivateHint')}
          />
          {priv && <Callout tone="warning" title={t('channels.privateWarn')} />}
        </>
      )}
      {type !== 'email' && (
        <TextField
          control={control}
          name="secret"
          type="password"
          autoComplete="new-password"
          label={t(type === 'telegram' ? 'channels.botToken' : 'channels.hmacSecret')}
          description={channel?.secret_set ? t('channels.secretKeep') : t('channels.secretHint')}
          {...(channel ? { optional: true } : {})}
        />
      )}
      <SwitchField control={control} name="enabled" label={t('alerts.enabled')} />
    </FormDialog>
  );
}
