import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { SelectField, SwitchField, TextField } from '@/shared/page/fields';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { get, send } from '../api';
import { useAction } from '../useAction';
import { SecurityNav } from './common';
import { splitList, sshSchema, type SshForm } from './forms';

export default function SshPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'security', 'ssh'],
    queryFn: () => get('/api/v1/admin/security/ssh'),
  });
  const { control, handleSubmit, reset, formState } = useForm<SshForm>({
    resolver: zodResolver(sshSchema),
  });
  useEffect(() => {
    if (q.data) reset({ ...q.data, allow_groups: q.data.allow_groups.join(', ') });
  }, [q.data, reset]);
  const save = useAction((v: SshForm) =>
    send('PATCH', '/api/v1/admin/security/ssh', {
      body: { ...v, allow_groups: splitList(v.allow_groups) },
      headers: q.data ? { 'If-Match': `"${q.data.updated_at}"` } : {},
    }),
  );
  return (
    <>
      <PageHeader
        title={t('sec.sshTitle')}
        description={t('sec.sshDescription')}
        nav={<SecurityNav current="ssh" />}
      />
      {q.isLoading && <PageSkeleton />}
      {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && (
        <form
          noValidate
          onSubmit={(e) => void handleSubmit((v) => save.mutate(v))(e)}
          className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]"
        >
          <Card>
            <CardHeader
              title={t('sec.sshConfig')}
              description={t('sec.updated', { at: fmt.rel(q.data.updated_at) })}
            />
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  control={control}
                  name="port"
                  type="number"
                  inputMode="numeric"
                  label={t('sec.sshPort')}
                  description={t('sec.sshPortHint')}
                />
                <TextField
                  control={control}
                  name="max_auth_tries"
                  type="number"
                  inputMode="numeric"
                  label={t('sec.maxTries')}
                />
              </div>
              <SelectField
                control={control}
                name="permit_root_login"
                label={t('sec.rootLogin')}
                options={[
                  { value: 'no', label: t('sec.root.no') },
                  { value: 'prohibit-password', label: t('sec.root.prohibit-password') },
                ]}
              />
              <TextField
                control={control}
                name="allow_groups"
                label={t('sec.allowGroups')}
                description={t('sec.allowGroupsHint')}
              />
              <SwitchField
                control={control}
                name="password_authentication"
                label={t('sec.passwordAuth')}
                description={t('sec.passwordAuthHint')}
              />
              <div className="flex justify-end">
                <Button type="submit" disabled={save.isPending || !formState.isDirty}>
                  {t('sec.apply')}
                </Button>
              </div>
            </CardContent>
          </Card>
          <div className="flex flex-col gap-4">
            <Alert tone="warning" title={t('sec.sshWarnTitle')}>
              {t('sec.sshWarn')}
            </Alert>
            <Alert tone="info" title={t('sec.viaAgent')}>
              {t('sec.viaAgentHint')}
            </Alert>
          </div>
        </form>
      )}
    </>
  );
}
