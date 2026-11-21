import { useEffect, useReducer, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { JobAccepted } from '@/shared/api/realm';
import { useFmt } from '@/shared/format/useFmt';
import { setJobDrawerOpen } from '@/shared/jobs/jobStore';
import { SelectField, SwitchField, TextField } from '@/shared/page/fields';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { get, send } from '../api';
import { mmss, safeApplyReducer, secondsLeft } from '../servers/firewall';
import { useAction } from '../useAction';
import { SecurityNav } from './common';
import { splitList, sshSchema, type SshForm } from './forms';
import { useSecurityServer } from './useServer';

/**
 * SSH hardening (D-77): áp dụng an toàn như tường lửa. Sau khi agent nạp lại sshd, phải bấm "Giữ cấu hình mới" trong
 * thời hạn, nếu không agent tự khôi phục cấu hình cũ (phòng mất SSH).
 */
export default function SshPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const qc = useQueryClient();
  const { server, picker } = useSecurityServer();
  const key = ['admin', 'security', 'ssh', server];
  const q = useQuery({
    queryKey: key,
    enabled: server !== '',
    queryFn: () => get('/api/v1/admin/security/ssh', { query: { server } }),
  });
  const { control, handleSubmit, reset, formState } = useForm<SshForm>({
    resolver: zodResolver(sshSchema),
  });
  const [state, dispatch] = useReducer(safeApplyReducer, { phase: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (q.data && (state.phase === 'idle' || state.phase === 'rolledBack'))
      reset({ ...q.data, allow_groups: q.data.allow_groups.join(', '), rollback_after_sec: 120 });
  }, [q.data, reset, state.phase]);
  const job = useQuery({
    queryKey: ['admin', 'job', state.phase === 'applying' ? state.jobUuid : ''],
    enabled: state.phase === 'applying',
    queryFn: () =>
      get('/api/v1/admin/jobs/{id}', {
        path: { id: state.phase === 'applying' ? state.jobUuid : '' },
      }),
    refetchInterval: 800,
  });
  useEffect(() => {
    if (job.data?.state === 'succeeded') dispatch({ type: 'jobDone', now: Date.now() });
    if (job.data?.state === 'failed') dispatch({ type: 'jobFailed' });
  }, [job.data?.state]);
  useEffect(() => {
    if (state.phase !== 'awaiting') return;
    setJobDrawerOpen(false);
    const h = setInterval(() => {
      const n = Date.now();
      setNow(n);
      dispatch({ type: 'tick', now: n });
    }, 250);
    return () => clearInterval(h);
  }, [state.phase]);
  useEffect(() => {
    if (state.phase === 'rolledBack' || state.phase === 'confirmed')
      void qc.invalidateQueries({ queryKey: key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  const save = useAction(
    (v: SshForm) =>
      send<JobAccepted>('PATCH', '/api/v1/admin/security/ssh', {
        query: { server },
        body: { ...v, allow_groups: splitList(v.allow_groups) },
        headers: q.data ? { 'If-Match': `"${q.data.updated_at}"` } : {},
      }),
    {
      onSuccess: (r, v) =>
        dispatch({ type: 'applied', jobUuid: r.job.uuid, seconds: v.rollback_after_sec }),
    },
  );
  const confirm = useAction(
    () => send('POST', '/api/v1/admin/security/ssh:confirm', { query: { server } }),
    {
      success: t('sec.sshConfirmedToast'),
      onSuccess: () => dispatch({ type: 'confirmed' }),
    },
  );
  const pwd = useWatch({ control, name: 'password_authentication' });
  const noKeys = q.data?.admin_keys === 0;
  const busy =
    state.phase === 'applying' || state.phase === 'awaiting' || state.phase === 'confirming';
  const left = secondsLeft(state, now);

  return (
    <>
      <PageHeader
        title={t('sec.sshTitle')}
        description={t('sec.sshDescription')}
        actions={busy ? undefined : picker}
        nav={<SecurityNav current="ssh" />}
      />
      <div className="mb-4 flex flex-col gap-3 empty:hidden" aria-live="polite">
        {state.phase === 'applying' && <Alert tone="info" title={t('sec.sshApplying')} />}
        {(state.phase === 'awaiting' || state.phase === 'confirming') && (
          <Alert
            tone="warning"
            title={t('firewall.awaiting', { time: mmss(left) })}
            action={
              <Button
                size="sm"
                onClick={() => {
                  dispatch({ type: 'confirm' });
                  confirm.mutate(undefined);
                }}
                disabled={state.phase === 'confirming'}
              >
                {t('firewall.keep')}
              </Button>
            }
          >
            <span data-testid="ssh-countdown" className="tabular-nums">
              {t('sec.sshAwaitingHint', { count: left })}
            </span>
          </Alert>
        )}
        {state.phase === 'confirmed' && (
          <Alert
            tone="success"
            title={t('sec.sshConfirmed')}
            action={
              <Button size="sm" variant="outline" onClick={() => dispatch({ type: 'reset' })}>
                {t('firewall.dismiss')}
              </Button>
            }
          />
        )}
        {state.phase === 'rolledBack' && (
          <Alert
            tone="danger"
            title={t('sec.sshRolledBack')}
            action={
              <Button size="sm" variant="outline" onClick={() => dispatch({ type: 'reset' })}>
                {t('firewall.dismiss')}
              </Button>
            }
          >
            {t('sec.sshRolledBackHint')}
          </Alert>
        )}
      </div>
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
              <fieldset disabled={busy} className="contents">
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
                {noKeys && !pwd && (
                  <Alert tone="danger" title={t('sec.sshNoKeysTitle')}>
                    {t('sec.sshNoKeys')}
                  </Alert>
                )}
                <TextField
                  control={control}
                  name="rollback_after_sec"
                  type="number"
                  inputMode="numeric"
                  label={t('firewall.rollbackAfter')}
                  description={t('sec.sshRollbackHint')}
                />
              </fieldset>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={save.isPending || busy || !formState.isDirty || (noKeys && !pwd)}
                >
                  {t('sec.apply')}
                </Button>
              </div>
            </CardContent>
          </Card>
          <div className="flex flex-col gap-4">
            <Alert tone="warning" title={t('sec.sshWarnTitle')}>
              {t('sec.sshWarn')}
            </Alert>
            <Alert tone="info" title={t('sec.sshKeys', { count: q.data.admin_keys ?? 0 })}>
              {t('sec.sshKeysHint')}
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
