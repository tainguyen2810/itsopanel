import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import {
  CRON_PRESETS,
  describeCron,
  minInterval,
  nextRuns,
  parseCron,
  type CronText,
} from '@/shared/hosting/cron';
import { SelectField, TextField } from '@/shared/page/fields';
import { FormDialog } from '@/shared/page/FormDialog';
import { ListPage } from '@/shared/page/ListPage';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Switch } from '@/ui/Checkbox';
import { CodeBlock } from '@/ui/CodeBlock';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import type { ColumnDef } from '@/ui/DataTable';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { FormField } from '@/ui/FormField';
import { list, send, type Row } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { Mono, RowMenu, useAccountFilter, useActiveAccounts } from './common';
import { cronSchema, type CronForm } from './forms';

type Cron = Row<'/cron-jobs'>;

/** Mô tả biểu thức cron bằng lời (VI/EN) từ `describeCron`. */
export function useCronText() {
  const { t } = useTranslation('admin');
  return (expr: string) => {
    const d: CronText = describeCron(expr);
    if (d.key === 'weekly') {
      return t('cron.text.weekly', {
        time: d.time,
        weekday: t(`cron.weekdays.${d.weekday}` as never),
      });
    }
    return t(`cron.text.${d.key}` as never, d as never) as unknown as string;
  };
}

export default function CronPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const text = useCronText();
  const accountFilter = useAccountFilter();
  const [editing, setEditing] = useState<Cron | 'new' | null>(null);
  const [history, setHistory] = useState<Cron | null>(null);
  const [removing, setRemoving] = useState<Cron | null>(null);
  const run = useAction((c: Cron) =>
    send('POST', '/cron-jobs/{id}:run', { path: { id: c.uuid }, body: {} }),
  );
  const toggle = useAction((c: Cron) =>
    send('PATCH', '/cron-jobs/{id}', {
      path: { id: c.uuid },
      body: { enabled: !c.enabled },
    }),
  );
  const remove = useAction(
    (c: Cron) => send('DELETE', '/cron-jobs/{id}', { path: { id: c.uuid } }),
    { onSuccess: () => setRemoving(null) },
  );
  const now = new Date();
  const columns: ColumnDef<Cron, unknown>[] = [
    {
      id: 'schedule',
      header: t('cron.schedule'),
      accessorKey: 'schedule',
      cell: ({ row }) => (
        <div className="flex flex-col">
          <Mono>{row.original.schedule}</Mono>
          <span className="text-sm text-muted">{text(row.original.schedule)}</span>
        </div>
      ),
    },
    {
      id: 'command',
      header: t('cron.command'),
      accessorKey: 'command',
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col">
          <Mono>{row.original.command}</Mono>
          <span className="text-xs text-muted">
            {row.original.hosting_account.username}
            {row.original.website ? ` · ${row.original.website.primary_domain}` : ''}
          </span>
        </div>
      ),
    },
    {
      id: 'next',
      header: t('cron.next'),
      accessorFn: (c) => (c.enabled ? (nextRuns(c.schedule, now, 1)[0]?.toISOString() ?? '') : ''),
      cell: ({ getValue, row }) =>
        row.original.enabled && getValue<string>() ? fmt.dateTime(getValue<string>()) : '—',
    },
    {
      id: 'last',
      header: t('cron.last'),
      accessorFn: (c) => c.last_run_at ?? '',
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-0.5">
          {row.original.last_status ? <StatusBadge status={row.original.last_status} /> : '—'}
          {row.original.last_run_at && (
            <span className="text-xs text-muted">{fmt.rel(row.original.last_run_at)}</span>
          )}
        </div>
      ),
    },
    {
      id: 'enabled',
      header: t('cron.enabled'),
      accessorFn: (c) => (c.enabled ? 1 : 0),
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          onCheckedChange={() => toggle.mutate(row.original)}
          aria-label={t('cron.toggle', { cmd: row.original.command })}
        />
      ),
    },
    {
      id: 'actions',
      header: t('sites.actions'),
      enableSorting: false,
      cell: ({ row }) => (
        <RowMenu
          label={t('cron.actionsFor', { cmd: row.original.command })}
          actions={[
            { label: t('cron.runNow'), onSelect: () => run.mutate(row.original) },
            { label: t('cron.history'), onSelect: () => setHistory(row.original) },
            { label: t('cron.edit'), onSelect: () => setEditing(row.original) },
            { label: t('cron.delete'), onSelect: () => setRemoving(row.original), danger: true },
          ]}
        />
      ),
    },
  ];
  return (
    <>
      <ListPage<Cron>
        title={t('cron.title')}
        description={t('cron.description')}
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('cron.add')}
          </Button>
        }
        queryKey={['admin', 'cron']}
        fetch={(q) => list('/cron-jobs', q)}
        filters={[accountFilter]}
        columns={columns}
        getRowId={(c) => c.uuid}
        primaryColumnId="schedule"
      />
      {editing && (
        <CronDialog cron={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {history && <History cron={history} onClose={() => setHistory(null)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t('cron.deleteTitle')}
        description={removing?.command ?? ''}
        confirmLabel={t('cron.delete')}
        onConfirm={() =>
          removing ? remove.mutateAsync(removing).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function CronDialog({ cron, onClose }: { cron: Cron | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const text = useCronText();
  const { options } = useActiveAccounts();
  const { control, handleSubmit, setValue } = useForm<CronForm>({
    resolver: zodResolver(cronSchema),
    defaultValues: cron
      ? {
          hosting_account_uuid: cron.hosting_account.uuid,
          schedule: cron.schedule,
          command: cron.command,
          working_dir: cron.working_dir,
          enabled: cron.enabled,
        }
      : {
          hosting_account_uuid: '',
          schedule: '*/15 * * * *',
          command: '',
          working_dir: '.',
          enabled: true,
        },
  });
  const schedule = useWatch({ control, name: 'schedule' });
  const valid = parseCron(schedule).ok;
  const runs = valid ? nextRuns(schedule, new Date(), 5) : [];
  const gap = valid ? minInterval(schedule) : null;
  const save = useAction(
    (v: CronForm) =>
      cron
        ? send('PATCH', '/cron-jobs/{id}', {
            path: { id: cron.uuid },
            body: {
              schedule: v.schedule,
              command: v.command,
              working_dir: v.working_dir,
              enabled: v.enabled,
            },
          })
        : send('POST', '/cron-jobs', {
            body: { ...v, website_uuid: null, php_version: null },
          }),
    { onSuccess: onClose },
  );
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={cron ? t('cron.editTitle') : t('cron.addTitle')}
      description={t('cron.formHint')}
      submitLabel={cron ? t('cron.save') : t('cron.create')}
      pending={save.isPending}
      onSubmit={() => void handleSubmit((v) => save.mutate(v))()}
    >
      {!cron && (
        <SelectField
          control={control}
          name="hosting_account_uuid"
          label={t('sites.account')}
          options={options}
          placeholder={t('sites.pickAccount')}
        />
      )}
      <TextField
        control={control}
        name="schedule"
        label={t('cron.schedule')}
        description={t('cron.scheduleHint')}
        autoComplete="off"
      />
      <div className="-mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t('cron.presets')}>
        {CRON_PRESETS.map((p) => (
          <Button
            key={p}
            type="button"
            size="sm"
            variant={p === schedule ? 'secondary' : 'ghost'}
            onClick={() => setValue('schedule', p, { shouldValidate: true })}
          >
            {text(p)}
          </Button>
        ))}
      </div>
      <div className="rounded-md border border-border bg-surface-2 p-3 text-sm" aria-live="polite">
        {valid ? (
          <>
            <p className="font-medium">{text(schedule)}</p>
            {gap !== null && <p className="text-muted">{t('cron.gap', { count: gap })}</p>}
            <p className="mt-2 text-muted">{t('cron.nextRuns')}</p>
            <ul className="tabular-nums">
              {runs.map((d) => (
                <li key={d.toISOString()}>{fmt.dateTime(d.toISOString())}</li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-danger-text">{t('sites.errors.cron')}</p>
        )}
      </div>
      <TextField
        control={control}
        name="command"
        label={t('cron.command')}
        placeholder="php artisan schedule:run"
        description={t('cron.commandHint')}
        autoComplete="off"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          control={control}
          name="working_dir"
          label={t('cron.workingDir')}
          description={t('cron.workingDirHint')}
        />
        <FormField
          control={control}
          name="enabled"
          label={t('cron.enabled')}
          render={(f) => (
            <Switch id={f.id} checked={f.value as boolean} onCheckedChange={f.onChange} />
          )}
        />
      </div>
    </FormDialog>
  );
}

function History({ cron, onClose }: { cron: Cron; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const q = useQuery({
    queryKey: ['admin', 'cron', cron.uuid, 'runs'],
    queryFn: () => list('/cron-jobs/{id}/runs', undefined, { path: { id: cron.uuid } }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('cron.historyTitle')}
        description={cron.command}
        className="max-w-2xl"
      >
        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : !q.data ? (
          <TableSkeleton rows={4} />
        ) : q.data.length === 0 ? (
          <p className="text-base text-muted">{t('cron.noRuns')}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {q.data.map((r) => (
              <li key={r.uuid} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={r.status} />
                  <span>{fmt.dateTime(r.started_at)}</span>
                  {r.exit_code !== null && <span className="text-muted">exit {r.exit_code}</span>}
                  {r.finished_at && (
                    <span className="text-muted">
                      {t('cron.duration', {
                        s: Math.max(
                          0,
                          Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000),
                        ),
                      })}
                    </span>
                  )}
                </div>
                <CodeBlock code={r.output_tail || '—'} />
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
