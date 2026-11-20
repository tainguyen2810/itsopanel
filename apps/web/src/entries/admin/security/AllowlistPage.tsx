import { useEffect } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { FormField } from '@/ui/FormField';
import { Input } from '@/ui/Input';
import { get, send } from '../api';
import { useAction } from '../useAction';
import { SecurityNav } from './common';
import { allowlistSchema, ipInCidr, type AllowlistForm } from './forms';

/** Danh sách IP được vào Admin Panel. Cảnh báo khi IP đang dùng không còn nằm trong danh sách. */
export default function AllowlistPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'security', 'allowlist'],
    queryFn: () => get('/api/v1/admin/security/ip-allowlist'),
  });
  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => get('/api/v1/auth/sessions'),
  });
  const myIp = sessions.data?.find((s) => s.current)?.ip ?? null;
  const { control, handleSubmit, reset, formState } = useForm<AllowlistForm>({
    resolver: zodResolver(allowlistSchema),
    defaultValues: { entries: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'entries' });
  const entries = useWatch({ control, name: 'entries' });
  useEffect(() => {
    if (q.data) reset({ entries: q.data.entries });
  }, [q.data, reset]);
  const save = useAction(
    (v: AllowlistForm) =>
      send('PUT', '/api/v1/admin/security/ip-allowlist', {
        body: { entries: v.entries, updated_at: q.data?.updated_at ?? '' },
      }),
    { success: t('sec.allowSaved'), invalidate: [['admin', 'security', 'allowlist']] },
  );
  const covered =
    myIp === null || (entries ?? []).some((e) => e.cidr && ipInCidr(myIp, e.cidr.trim()));
  const rootError = formState.errors.entries?.root?.message ?? formState.errors.entries?.message;
  return (
    <>
      <PageHeader
        title={t('sec.allowTitle')}
        description={t('sec.allowDescription')}
        nav={<SecurityNav current="allowlist" />}
      />
      {q.isLoading && <PageSkeleton />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (
        <form noValidate onSubmit={(e) => void handleSubmit((v) => save.mutate(v))(e)}>
          <Card>
            <CardHeader
              title={t('sec.allowEntries')}
              description={t('sec.updated', { at: fmt.rel(q.data.updated_at) })}
            />
            <CardContent className="flex flex-col gap-3">
              {myIp && (
                <Alert
                  tone={covered ? 'success' : 'danger'}
                  title={covered ? t('sec.myIpOk', { ip: myIp }) : t('sec.myIpOut', { ip: myIp })}
                >
                  {covered ? undefined : t('sec.myIpOutHint')}
                </Alert>
              )}
              <ul className="flex flex-col gap-3">
                {fields.map((f, i) => (
                  <li
                    key={f.id}
                    className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-start sm:border-0 sm:p-0"
                  >
                    <FormField
                      control={control}
                      name={`entries.${i}.cidr`}
                      label={t('sec.cidr')}
                      render={(p) => (
                        <Input
                          {...p}
                          value={String(p.value ?? '')}
                          className="font-mono"
                          placeholder="10.0.0.0/16"
                        />
                      )}
                    />
                    <FormField
                      control={control}
                      name={`entries.${i}.note`}
                      label={t('sec.note')}
                      render={(p) => <Input {...p} value={String(p.value ?? '')} />}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="sm:mt-6"
                      onClick={() => remove(i)}
                      aria-label={t('sec.removeEntry', {
                        cidr: entries?.[i]?.cidr || String(i + 1),
                      })}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
              {rootError && (
                <p role="alert" className="text-sm text-danger-text">
                  {t(rootError.replace(/^admin:/, '') as never)}
                </p>
              )}
              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => append({ cidr: '', note: '' })}
                >
                  <Plus aria-hidden />
                  {t('sec.addEntry')}
                </Button>
                <Button type="submit" disabled={save.isPending || !formState.isDirty}>
                  {t('sec.saveList')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </form>
      )}
    </>
  );
}
