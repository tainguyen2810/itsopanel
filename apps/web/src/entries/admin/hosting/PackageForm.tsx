import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { TextField } from '@/shared/page/fields';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Checkbox, Switch } from '@/ui/Checkbox';
import { FormField } from '@/ui/FormField';
import { Textarea } from '@/ui/Input';
import { LIMIT_GROUPS, PHP_VERSIONS, packageSchema, type PackageForm as Form } from './packages';

interface Props {
  defaultValues: Form;
  /** Sửa gói: không đổi mã; báo trước việc tạo phiên bản mới (D-43). */
  editing?: { version: number; accounts: number };
  pending: boolean;
  submitLabel: string;
  onSubmit: (v: Form) => void;
  onCancel?: () => void;
}

/** Form gói hosting: thông tin + giới hạn tài nguyên theo nhóm. Dùng cho tạo mới và sửa. */
export function PackageForm({
  defaultValues,
  editing,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit } = useForm<Form>({
    resolver: zodResolver(packageSchema),
    defaultValues,
  });
  return (
    <form noValidate onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      {editing && (
        <Alert tone="info" title={t('packages.versionNotice', { next: editing.version + 1 })}>
          {t('packages.versionNoticeHint', { count: editing.accounts })}
        </Alert>
      )}
      <Card>
        <CardHeader title={t('packages.info')} />
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {editing ? null : (
            <TextField
              control={control}
              name="code"
              label={t('packages.code')}
              description={t('packages.codeHint')}
              placeholder="student"
            />
          )}
          <TextField control={control} name="name" label={t('packages.name')} />
          <FormField
            control={control}
            name="description"
            label={t('packages.descriptionLabel')}
            optional
            className="sm:col-span-2"
            render={(f) => <Textarea {...f} rows={2} value={String(f.value ?? '')} />}
          />
        </CardContent>
      </Card>
      {LIMIT_GROUPS.map((g) => (
        <Card key={g.key}>
          <CardHeader title={t(`packages.groups.${g.key}`)} />
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.fields.map((f) => (
              <TextField
                key={f.name}
                control={control}
                name={`limits.${f.name}`}
                type="number"
                inputMode="numeric"
                label={t(`packages.limits.${f.name}`)}
              />
            ))}
          </CardContent>
        </Card>
      ))}
      <Card>
        <CardHeader title={t('packages.groups.policy')} />
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <TextField
            control={control}
            name="limits.backup_retention.daily"
            type="number"
            label={t('packages.retentionDaily')}
          />
          <TextField
            control={control}
            name="limits.backup_retention.weekly"
            type="number"
            label={t('packages.retentionWeekly')}
          />
          <TextField
            control={control}
            name="limits.backup_retention.monthly"
            type="number"
            label={t('packages.retentionMonthly')}
          />
          <TextField
            control={control}
            name="limits.retention_days_after_terminate"
            type="number"
            label={t('packages.limits.retention_days_after_terminate')}
            description={t('packages.retentionHint')}
          />
          <FormField
            control={control}
            name="limits.php_versions"
            label={t('packages.limits.php_versions')}
            className="sm:col-span-2"
            render={(f) => {
              const v = f.value as string[];
              return (
                <div id={f.id} role="group" className="flex flex-wrap gap-4">
                  {PHP_VERSIONS.map((p) => (
                    <label key={p} className="flex items-center gap-2 text-base">
                      <Checkbox
                        checked={v.includes(p)}
                        onCheckedChange={(c) =>
                          f.onChange(c === true ? [...v, p].sort() : v.filter((x) => x !== p))
                        }
                      />
                      PHP {p}
                    </label>
                  ))}
                </div>
              );
            }}
          />
          <FormField
            control={control}
            name="limits.ssh_allowed"
            label={t('packages.limits.ssh_allowed')}
            description={t('packages.sshHint')}
            render={(f) => (
              <Switch
                id={f.id}
                checked={f.value as boolean}
                onCheckedChange={f.onChange}
                aria-describedby={f['aria-describedby']}
              />
            )}
          />
        </CardContent>
      </Card>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('packages.cancel')}
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
