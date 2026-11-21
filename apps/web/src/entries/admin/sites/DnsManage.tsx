import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Cloud, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  NO_ACCOUNT,
  dnsProviderSchema,
  dnsZoneBody,
  dnsZoneSchema,
  zoneAccount,
  type DnsProviderForm,
  type DnsZoneForm,
} from '@/shared/hosting/dns';
import { useActiveAccounts } from '@/shared/hosting/pages/common';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { useSession } from '@/shared/session/SessionContext';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { EmptyState } from '@/ui/Feedback';
import { Select } from '@/ui/Select';
import { Label } from '@/ui/Label';
import { list, send, type Row } from '../api';
import { useAction } from '../useAction';

type Provider = Row<'/api/v1/admin/dns/providers'>;
type Zone = Row<'/api/v1/admin/dns/zones'>;
const PROVIDERS_KEY = ['admin', 'dns', 'providers'];
const ZONES_KEY = ['admin', 'dns', 'zones'];

/** Chỉ SUPER_ADMIN quản lý nhà cung cấp DNS và zone hệ thống (quyền dns.providers). */
export function useIsSuperAdmin() {
  return useSession().can(['SUPER_ADMIN']);
}

export function useProviders(enabled = true) {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => list('/api/v1/admin/dns/providers'),
    enabled,
  });
}

/** Danh sách nhà cung cấp (Cloudflare) với thêm/xóa. Token chỉ gửi một lần, không hiển thị lại. */
export function ProvidersDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const providers = useProviders(open);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const remove = useAction(
    (p: Provider) => send('DELETE', '/api/v1/admin/dns/providers/{id}', { path: { id: p.uuid } }),
    {
      success: t('dns.providerRemoved'),
      invalidate: [PROVIDERS_KEY],
      onSuccess: () => setRemoving(null),
    },
  );
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent title={t('dns.providerList')} description={t('dns.providerListHint')}>
          <div className="flex flex-col gap-3">
            {(providers.data ?? []).length === 0 ? (
              <EmptyState
                icon={Cloud}
                title={t('dns.noProviders')}
                description={t('dns.noProvidersHint')}
              />
            ) : (
              <ul className="flex flex-col divide-y divide-border rounded-md border">
                {(providers.data ?? []).map((p) => (
                  <li key={p.uuid} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <p className="font-medium break-all">{p.name}</p>
                      <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
                        <Badge tone="neutral">{t(`dns.providers.${p.type}`)}</Badge>
                        {p.account_label ? (
                          <span className="break-all">{p.account_label}</span>
                        ) : null}
                        <span>{t('dns.zonesCount', { count: p.zones_count })}</span>
                      </p>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t('dns.removeProvider', { name: p.name })}
                      onClick={() => setRemoving(p)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus aria-hidden />
                {t('dns.addProvider')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <ProviderDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('dns.removeProviderTitle', { name: removing?.name ?? '' })}
        description={t('dns.removeProviderHint')}
        confirmLabel={t('dns.removeProviderConfirm')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function ProviderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit, reset } = useForm<DnsProviderForm>({
    resolver: zodResolver(dnsProviderSchema),
    defaultValues: { name: '', api_token: '' },
  });
  const add = useAction(
    (v: DnsProviderForm) =>
      send('POST', '/api/v1/admin/dns/providers', {
        body: { type: 'cloudflare', name: v.name.trim(), api_token: v.api_token.trim() },
      }),
    {
      success: t('dns.providerAdded'),
      invalidate: [PROVIDERS_KEY],
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
      title={t('dns.addProvider')}
      description={t('dns.addProviderHint')}
      submitLabel={t('dns.addProvider')}
      pending={add.isPending}
      onSubmit={() => void handleSubmit((v) => add.mutate(v))()}
    >
      <TextField
        control={control}
        name="name"
        label={t('dns.providerName')}
        placeholder="Cloudflare ITSO"
      />
      <TextField
        control={control}
        name="api_token"
        type="password"
        autoComplete="off"
        label={t('dns.apiToken')}
        description={t('dns.apiTokenHint')}
      />
    </FormDialog>
  );
}

/** Gắn zone đã có trong tài khoản Cloudflare của provider; panel đọc record về ngay. */
export function ZoneDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (z: Zone) => void;
}) {
  const { t } = useTranslation('admin');
  const sa = useIsSuperAdmin();
  const providers = useProviders(open);
  const { options } = useActiveAccounts(open);
  const { control, handleSubmit, reset } = useForm<DnsZoneForm>({
    resolver: zodResolver(dnsZoneSchema),
    defaultValues: { provider_uuid: '', name: '', hosting_account_uuid: sa ? NO_ACCOUNT : '' },
  });
  const add = useAction(
    (v: DnsZoneForm) => send<Zone>('POST', '/api/v1/admin/dns/zones', { body: dnsZoneBody(v) }),
    {
      success: t('dns.zoneAdded'),
      invalidate: [ZONES_KEY],
      onSuccess: (z) => {
        reset();
        onOpenChange(false);
        onCreated(z);
      },
    },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('dns.addZone')}
      description={t('dns.addZoneHint')}
      submitLabel={t('dns.addZone')}
      pending={add.isPending}
      onSubmit={() =>
        void handleSubmit((v) => {
          if (!sa && zoneAccount(v.hosting_account_uuid) === null) return;
          add.mutate(v);
        })()
      }
    >
      <SelectField
        control={control}
        name="provider_uuid"
        label={t('dns.provider')}
        placeholder={t('dns.pickProvider')}
        options={(providers.data ?? []).map((p) => ({ value: p.uuid, label: p.name }))}
        {...(sa && (providers.data ?? []).length === 0 && providers.isSuccess
          ? { description: t('dns.noProvidersHint') }
          : {})}
      />
      <TextField
        control={control}
        name="name"
        label={t('dns.zoneName')}
        placeholder="anphat.vn"
        autoComplete="off"
      />
      <SelectField
        control={control}
        name="hosting_account_uuid"
        label={t('dns.zoneAccount')}
        description={sa ? t('dns.zoneAccountHintSa') : t('dns.zoneAccountHint')}
        placeholder={t('sites.pickAccount')}
        options={[...(sa ? [{ value: NO_ACCOUNT, label: t('dns.system') }] : []), ...options]}
      />
    </FormDialog>
  );
}

/** Đổi account gắn với zone (PATCH /admin/dns/zones/{id}). */
export function ZoneAccountDialog({ zone, onClose }: { zone: Zone; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const sa = useIsSuperAdmin();
  const { options } = useActiveAccounts();
  const [value, setValue] = useState(zone.hosting_account?.uuid ?? (sa ? NO_ACCOUNT : ''));
  const save = useAction(
    () =>
      send('PATCH', '/api/v1/admin/dns/zones/{id}', {
        path: { id: zone.uuid },
        body: { hosting_account_uuid: zoneAccount(value) },
      }),
    { success: t('dns.zoneUpdated'), invalidate: [ZONES_KEY], onSuccess: onClose },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('dns.zoneAccountTitle', { name: zone.name })}
      submitLabel={t('dns.save')}
      pending={save.isPending}
      onSubmit={() => {
        if (value !== '') save.mutate();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="zone-account">{t('dns.zoneAccount')}</Label>
        <Select
          id="zone-account"
          value={value || undefined}
          onValueChange={setValue}
          placeholder={t('sites.pickAccount')}
          options={[...(sa ? [{ value: NO_ACCOUNT, label: t('dns.system') }] : []), ...options]}
        />
      </div>
    </FormDialog>
  );
}
