import { useEffect, useReducer, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/http';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { PageHeader } from '@/shared/page/PageHeader';
import { setJobDrawerOpen } from '@/shared/jobs/jobStore';
import { useSession } from '@/shared/session/SessionContext';
import { Alert } from '@/ui/Alert';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { get, list, send, type JobAccepted, type Row } from '../api';
import { useAction } from '../useAction';
import { ServerNav, useServer } from './common';
import {
  mmss,
  ruleSchema,
  safeApplyReducer,
  secondsLeft,
  toRuleInput,
  type RuleForm,
} from './firewall';

type Rule = Row<'/api/v1/admin/servers/{id}/firewall/rules'>;

export default function ServerFirewallPage() {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  const server = useServer();
  const qc = useQueryClient();
  const sa = user.role === 'SUPER_ADMIN';
  const key = ['admin', 'server', server.id, 'firewall'];
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const [dirty, setDirty] = useState(0);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Rule | null>(null);
  const [applying, setApplying] = useState(false);
  const [state, dispatch] = useReducer(safeApplyReducer, { phase: 'idle' });
  const [now, setNow] = useState(() => Date.now());

  // Theo dõi job áp dụng; xong thì bắt đầu đếm ngược.
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
    // Đóng drawer job để nút xác nhận không bị che trong lúc đếm ngược.
    setJobDrawerOpen(false);
    const h = setInterval(() => {
      const n = Date.now();
      setNow(n);
      dispatch({ type: 'tick', now: n });
    }, 250);
    return () => clearInterval(h);
  }, [state.phase]);
  useEffect(() => {
    if (state.phase === 'rolledBack') refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  const remove = useAction(
    (r: Rule) =>
      send('DELETE', '/api/v1/admin/servers/{id}/firewall/rules/{rule}', {
        path: { id: server.id, rule: r.uuid },
      }),
    {
      success: t('firewall.removed'),
      invalidate: [key],
      onSuccess: () => {
        setDirty((d) => d + 1);
        setRemoving(null);
      },
    },
  );
  const apply = useAction(
    (seconds: number) =>
      send<JobAccepted>('POST', '/api/v1/admin/servers/{id}/firewall:apply', {
        path: { id: server.id },
        body: { rollback_after_sec: seconds },
      }),
    {
      onSuccess: (r, seconds) => {
        setApplying(false);
        dispatch({ type: 'applied', jobUuid: r.job.uuid, seconds });
      },
    },
  );
  const confirm = useAction(
    () => send('POST', '/api/v1/admin/servers/{id}/firewall:confirm', { path: { id: server.id } }),
    {
      success: t('firewall.confirmedToast'),
      onSuccess: () => {
        dispatch({ type: 'confirmed' });
        setDirty(0);
      },
    },
  );

  const columns: ColumnDef<Rule, unknown>[] = [
    { id: 'priority', header: t('firewall.priority'), accessorKey: 'priority' },
    {
      id: 'action',
      header: t('firewall.action'),
      accessorKey: 'action',
      cell: ({ row }) => (
        <Badge tone={row.original.action === 'accept' ? 'success' : 'danger'}>
          {t(`firewall.actions.${row.original.action}`)}
        </Badge>
      ),
    },
    {
      id: 'direction',
      header: t('firewall.direction'),
      accessorFn: (r) => t(`firewall.directions.${r.direction}`),
    },
    { id: 'protocol', header: t('firewall.protocol'), accessorFn: (r) => r.protocol.toUpperCase() },
    {
      id: 'ports',
      header: t('firewall.ports'),
      accessorFn: (r) => r.ports ?? t('firewall.allPorts'),
    },
    {
      id: 'source',
      header: t('firewall.source'),
      accessorKey: 'source',
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.source}</span>,
    },
    { id: 'comment', header: t('firewall.comment'), accessorFn: (r) => r.comment ?? '' },
    {
      id: 'enabled',
      header: t('servers.status'),
      accessorFn: (r) => (r.enabled ? 'active' : 'disabled'),
      cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
    },
    ...(sa
      ? [
          {
            id: 'remove',
            header: t('servers.actions'),
            enableSorting: false,
            cell: ({ row }) => (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('firewall.remove', { priority: row.original.priority })}
                disabled={
                  state.phase !== 'idle' &&
                  state.phase !== 'confirmed' &&
                  state.phase !== 'rolledBack'
                }
                onClick={() => setRemoving(row.original)}
              >
                <Trash2 aria-hidden />
              </Button>
            ),
          } satisfies ColumnDef<Rule, unknown>,
        ]
      : []),
  ];
  const busy =
    state.phase === 'applying' || state.phase === 'awaiting' || state.phase === 'confirming';
  const left = secondsLeft(state, now);

  return (
    <>
      <PageHeader
        nav={<ServerNav current="firewall" />}
        title={t('firewall.title')}
        description={t('firewall.description')}
        actions={
          sa ? (
            <>
              <Button variant="outline" onClick={() => setAdding(true)} disabled={busy}>
                <Plus aria-hidden />
                {t('firewall.add')}
              </Button>
              <Button onClick={() => setApplying(true)} disabled={busy || dirty === 0}>
                <ShieldCheck aria-hidden />
                {t('firewall.apply')}
              </Button>
            </>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-col gap-3 empty:hidden" aria-live="polite">
        {dirty > 0 && state.phase === 'idle' && (
          <Alert tone="info" title={t('firewall.pending', { count: dirty })}>
            {t('firewall.pendingHint')}
          </Alert>
        )}
        {state.phase === 'applying' && <Alert tone="info" title={t('firewall.applying')} />}
        {(state.phase === 'awaiting' || state.phase === 'confirming') && (
          <Alert
            tone="warning"
            title={t('firewall.awaiting', { time: mmss(left) })}
            action={
              <Button
                size="sm"
                onClick={() => {
                  dispatch({ type: 'confirm' });
                  confirm.mutate();
                }}
                disabled={state.phase === 'confirming'}
              >
                {t('firewall.keep')}
              </Button>
            }
          >
            <span data-testid="firewall-countdown" className="tabular-nums">
              {t('firewall.awaitingHint', { count: left })}
            </span>
          </Alert>
        )}
        {state.phase === 'confirmed' && (
          <Alert
            tone="success"
            title={t('firewall.confirmed')}
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
            title={t('firewall.rolledBack')}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDirty(0);
                  dispatch({ type: 'reset' });
                }}
              >
                {t('firewall.dismiss')}
              </Button>
            }
          >
            {t('firewall.rolledBackHint')}
          </Alert>
        )}
      </div>
      <ListPage<Rule>
        embedded
        search={false}
        title={t('firewall.title')}
        queryKey={key}
        fetch={() =>
          list('/api/v1/admin/servers/{id}/firewall/rules', undefined, { path: { id: server.id } })
        }
        columns={columns}
        getRowId={(r) => r.uuid}
        primaryColumnId="priority"
      />
      {sa && (
        <AddRule
          serverId={server.id}
          open={adding}
          onOpenChange={setAdding}
          onAdded={() => {
            setDirty((d) => d + 1);
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('firewall.removeTitle')}
        description={
          removing
            ? `${removing.priority} · ${removing.protocol.toUpperCase()} ${removing.ports ?? ''} ← ${removing.source}`
            : undefined
        }
        confirmLabel={t('firewall.removeConfirm')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
      <ApplyDialog
        open={applying}
        onOpenChange={setApplying}
        pending={apply.isPending}
        onApply={(s) => apply.mutate(s)}
      />
    </>
  );
}

function ApplyDialog({
  open,
  onOpenChange,
  pending,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pending: boolean;
  onApply: (seconds: number) => void;
}) {
  const { t } = useTranslation('admin');
  const [sec, setSec] = useState(120);
  const valid = Number.isInteger(sec) && sec >= 30 && sec <= 600;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('firewall.applyTitle')}
      description={t('firewall.applyHint')}
      submitLabel={t('firewall.apply')}
      pending={pending || !valid}
      onSubmit={() => valid && onApply(sec)}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rollback">{t('firewall.rollbackAfter')}</Label>
        <Input
          id="rollback"
          type="number"
          min={30}
          max={600}
          value={Number.isNaN(sec) ? '' : sec}
          aria-invalid={!valid}
          aria-describedby="rollback-hint"
          onChange={(e) => setSec(e.target.valueAsNumber)}
        />
        <p id="rollback-hint" className="text-sm text-muted">
          {t('firewall.rollbackHint')}
        </p>
      </div>
    </FormDialog>
  );
}

function AddRule({
  serverId,
  open,
  onOpenChange,
  onAdded,
}: {
  serverId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation('admin');
  const { control, handleSubmit, reset } = useForm<RuleForm>({
    resolver: zodResolver(ruleSchema),
    defaultValues: {
      priority: 100,
      action: 'accept',
      direction: 'in',
      protocol: 'tcp',
      ports: '',
      source: '',
      comment: '',
    },
  });
  const protocol = useWatch({ control, name: 'protocol' });
  const add = useAction(
    (v: RuleForm) =>
      send('POST', '/api/v1/admin/servers/{id}/firewall/rules', {
        path: { id: serverId },
        body: toRuleInput(v),
      }),
    {
      success: t('firewall.added'),
      onSuccess: () => {
        reset();
        onOpenChange(false);
        onAdded();
      },
    },
  );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('firewall.addTitle')}
      description={t('firewall.addHint')}
      pending={add.isPending}
      onSubmit={() => void handleSubmit((v) => add.mutate(v))()}
    >
      {add.error instanceof ApiError && add.error.problem.code === 'would_lock_out' && (
        <Alert tone="danger" title={t('firewall.lockoutTitle')}>
          {add.error.problem.detail}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          control={control}
          name="priority"
          type="number"
          label={t('firewall.priority')}
          description={t('firewall.priorityHint')}
        />
        <SelectField
          control={control}
          name="action"
          label={t('firewall.action')}
          options={(['accept', 'drop', 'reject'] as const).map((v) => ({
            value: v,
            label: t(`firewall.actions.${v}`),
          }))}
        />
        <SelectField
          control={control}
          name="direction"
          label={t('firewall.direction')}
          options={(['in', 'out'] as const).map((v) => ({
            value: v,
            label: t(`firewall.directions.${v}`),
          }))}
        />
        <SelectField
          control={control}
          name="protocol"
          label={t('firewall.protocol')}
          options={['tcp', 'udp', 'icmp', 'any'].map((p) => ({ value: p, label: p.toUpperCase() }))}
        />
        <TextField
          control={control}
          name="ports"
          label={t('firewall.ports')}
          placeholder="80,443"
          description={t('firewall.portsHint')}
          optional={protocol === 'icmp' || protocol === 'any'}
        />
        <TextField
          control={control}
          name="source"
          label={t('firewall.source')}
          placeholder="10.10.0.0/16"
          description={t('firewall.sourceHint')}
        />
      </div>
      <TextField control={control} name="comment" label={t('firewall.comment')} optional />
    </FormDialog>
  );
}
