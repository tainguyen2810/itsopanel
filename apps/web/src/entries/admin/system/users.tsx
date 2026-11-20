import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { useSession } from '@/shared/session/SessionContext';
import { SelectField, SwitchField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { Alert } from '@/ui/Alert';
import { CodeBlock } from '@/ui/CodeBlock';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { FormField } from '@/ui/FormField';
import { Textarea } from '@/ui/Input';
import { send, type Row } from '../api';
import { useAction } from '../useAction';

export type User = Row<'/api/v1/admin/users'>;

export const userSchema = z
  .object({
    realm: z.enum(['admin', 'portal']),
    name: z.string().trim().min(1, 'form.required').max(120, 'form.maxLength|120'),
    email: z.email('form.email'),
    role: z.enum(['SUPER_ADMIN', 'ADMIN', 'USER']),
    locale: z.enum(['vi', 'en']),
    send_invite: z.boolean(),
  })
  .refine((v) => (v.realm === 'portal') === (v.role === 'USER'), {
    path: ['role'],
    message: 'admin:users.errors.role',
  });
export type UserForm = z.infer<typeof userSchema>;

export const reasonSchema = z.object({
  reason: z.string().trim().min(5, 'form.minLength|5').max(500, 'form.maxLength|500'),
});

/** Thao tác SA/ADMIN được làm trên một người dùng (giống quy tắc API: không tự thao tác mình). */
export function useUserPolicy() {
  const { user: me } = useSession();
  return {
    me,
    canManage: (u: User) =>
      u.uuid !== me.uuid && (me.role === 'SUPER_ADMIN' || u.realm === 'portal'),
    canImpersonate: (u: User) =>
      u.realm === 'portal' && u.status === 'active' && u.uuid !== me.uuid,
  };
}

export function CreateUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation('admin');
  const { me } = useUserPolicy();
  const empty: UserForm = {
    realm: 'portal',
    name: '',
    email: '',
    role: 'USER',
    locale: 'vi',
    send_invite: true,
  };
  const { control, handleSubmit, reset, setValue } = useForm<UserForm>({
    resolver: zodResolver(userSchema),
    defaultValues: empty,
  });
  const realm = useWatch({ control, name: 'realm' });
  const close = (o: boolean) => {
    if (!o) reset(empty);
    onOpenChange(o);
  };
  const create = useAction((v: UserForm) => send('POST', '/api/v1/admin/users', { body: v }), {
    success: t('users.created'),
    invalidate: [['admin', 'users']],
    onSuccess: () => close(false),
  });
  const roles = realm === 'admin' ? (['ADMIN', 'SUPER_ADMIN'] as const) : (['USER'] as const);
  return (
    <FormDialog
      open={open}
      onOpenChange={close}
      title={t('users.add')}
      description={t('users.addHint')}
      submitLabel={t('users.create')}
      pending={create.isPending}
      onSubmit={() => void handleSubmit((v) => create.mutate(v))()}
    >
      {me.role === 'SUPER_ADMIN' && (
        <FormField
          control={control}
          name="realm"
          label={t('users.realm')}
          description={t('users.realmHint')}
          render={(f) => (
            <div id={f.id} role="radiogroup" className="flex flex-wrap gap-4">
              {(['portal', 'admin'] as const).map((r) => (
                <label key={r} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="realm"
                    value={r}
                    checked={f.value === r}
                    onChange={() => {
                      f.onChange(r);
                      setValue('role', r === 'admin' ? 'ADMIN' : 'USER');
                    }}
                    className="accent-[var(--itso-primary)]"
                  />
                  {t(`roles.realm.${r}`)}
                </label>
              ))}
            </div>
          )}
        />
      )}
      <TextField control={control} name="name" label={t('users.name')} />
      <TextField
        control={control}
        name="email"
        type="email"
        autoComplete="off"
        label={t('users.email')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          control={control}
          name="role"
          label={t('users.role')}
          options={roles.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
        />
        <SelectField
          control={control}
          name="locale"
          label={t('users.locale')}
          options={[
            { value: 'vi', label: 'Tiếng Việt' },
            { value: 'en', label: 'English' },
          ]}
        />
      </div>
      <SwitchField
        control={control}
        name="send_invite"
        label={t('users.sendInvite')}
        description={t('users.sendInviteHint')}
      />
    </FormDialog>
  );
}

/** Đăng nhập thay người dùng portal: bắt buộc lý do, phiên 30 phút, ghi audit. */
export function ImpersonateDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [result, setResult] = useState<{ portal_url: string; expires_at: string } | null>(null);
  const { control, handleSubmit, reset } = useForm<{ reason: string }>({
    resolver: zodResolver(reasonSchema),
    defaultValues: { reason: '' },
  });
  const close = () => {
    reset({ reason: '' });
    setResult(null);
    onClose();
  };
  const start = useAction(
    (v: { reason: string }) =>
      send<{ portal_url: string; expires_at: string }>(
        'POST',
        '/api/v1/admin/users/{id}:impersonate',
        {
          path: { id: user?.uuid ?? '' },
          body: v,
        },
      ),
    { invalidate: [['admin', 'audit']], onSuccess: (r) => setResult(r) },
  );
  if (result) {
    return (
      <Dialog open={user !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent
          title={t('users.impStarted', { name: user?.name ?? '' })}
          description={t('users.impExpires', { at: fmt.dateTime(result.expires_at) })}
        >
          <div className="flex flex-col gap-3">
            <CodeBlock code={result.portal_url} label={t('users.impUrl')} wrap />
            <Alert tone="warning" title={t('users.impAudit')} />
          </div>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <FormDialog
      open={user !== null}
      onOpenChange={(o) => !o && close()}
      title={t('users.impTitle', { name: user?.name ?? '' })}
      description={t('users.impHint')}
      submitLabel={t('users.impStart')}
      pending={start.isPending}
      onSubmit={() => void handleSubmit((v) => start.mutate(v))()}
    >
      <FormField
        control={control}
        name="reason"
        label={t('users.reason')}
        description={t('users.reasonHint')}
        render={(f) => <Textarea {...f} value={String(f.value ?? '')} rows={3} />}
      />
    </FormDialog>
  );
}
