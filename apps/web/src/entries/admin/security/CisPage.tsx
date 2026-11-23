import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleSlash, ScanSearch, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { AppLink } from '@/ui/AppLink';
import { StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { Gauge } from '@/ui/Gauge';
import { Select } from '@/ui/Select';
import { StatCard } from '@/ui/StatCard';
import { get, send, type Data, type JobAccepted } from '../api';
import { useAction } from '../useAction';
import { SecurityNav } from './common';
import { useSecurityServer } from './useServer';

type Report = Data<'/api/v1/admin/security/cis'>;
type CisItem = Report['items'][number];
const GROUPS = [
  'filesystem',
  'services',
  'network',
  'logging',
  'access',
  'accounts',
  'updates',
] as const;
const ALL = '__all';

/**
 * Kiểm CIS Ubuntu 24.04 L1 phần liên quan máy chủ hosting (D-109): chỉ đọc, panel không tự sửa; mục sửa được trỏ
 * tới trang có sẵn (SSH, tường lửa, phần mềm).
 */
export default function CisPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const { server, picker } = useSecurityServer();
  const report = useQuery({
    queryKey: ['admin', 'security', 'cis', server],
    enabled: !!server,
    queryFn: () => get('/api/v1/admin/security/cis', { query: { server } }),
  });
  const audit = useAction(
    () => send<JobAccepted>('POST', '/api/v1/admin/security/cis:audit', { query: { server } }),
    { invalidate: [['admin', 'security', 'cis']] },
  );
  const [group, setGroup] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);
  const r = report.data;
  const rows = useMemo(
    () =>
      (r?.items ?? []).filter(
        (x) => (group === ALL || x.group === group) && (status === ALL || x.status === status),
      ),
    [r, group, status],
  );
  const columns: ColumnDef<CisItem, unknown>[] = [
    {
      id: 'id',
      header: t('cis.id'),
      accessorKey: 'id',
      cell: ({ row }) => <span className="font-mono text-sm">{row.original.id}</span>,
    },
    {
      id: 'title',
      header: t('cis.check'),
      accessorKey: 'title',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium">{row.original.title}</p>
          <p className="text-sm text-muted">{t(`cis.groups.${row.original.group}`)}</p>
        </div>
      ),
    },
    {
      id: 'status',
      header: t('sites.status'),
      accessorKey: 'status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: 'evidence',
      header: t('cis.evidence'),
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col gap-1 text-sm">
          <code className="font-mono wrap-anywhere text-muted">{row.original.evidence}</code>
          {row.original.remediation && <span>{row.original.remediation}</span>}
          {row.original.fix_href && (
            <AppLink href={row.original.fix_href} className="text-primary-text hover:underline">
              {t('cis.fixHere')}
            </AppLink>
          )}
        </div>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={t('cis.title')}
        description={t('cis.description')}
        nav={<SecurityNav current="cis" />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {picker}
            <Button onClick={() => audit.mutate()} disabled={audit.isPending || !server}>
              <ScanSearch aria-hidden />
              {t('cis.audit')}
            </Button>
          </div>
        }
      />
      {report.isLoading || !server ? (
        <TableSkeleton />
      ) : report.error || !r ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : !r.audited_at ? (
        <Alert tone="info" title={t('cis.never', { server: r.server.name })}>
          {t('cis.neverHint')}
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
            <Card className="grid place-items-center p-4">
              <Gauge
                value={r.score}
                label={t('cis.score')}
                detail={t('cis.scoreDetail', { passed: r.passed, total: r.passed + r.failed })}
                tone={r.score >= 80 ? 'success' : r.score >= 60 ? 'warning' : 'danger'}
              />
            </Card>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                icon={CheckCircle2}
                tone="success"
                label={t('cis.passed')}
                value={String(r.passed)}
              />
              <StatCard
                icon={XCircle}
                tone="danger"
                label={t('cis.failed')}
                value={String(r.failed)}
              />
              <StatCard
                icon={CircleSlash}
                tone="neutral"
                label={t('cis.na')}
                value={String(r.not_applicable)}
                hint={t('cis.naHint')}
              />
              <p className="text-sm text-muted sm:col-span-3">
                {t('cis.audited', { profile: r.profile, at: fmt.dateTime(r.audited_at) })}
              </p>
            </div>
          </div>
          <Card>
            <CardHeader title={t('cis.items')} description={t('cis.readOnly')} />
            <CardContent>
              <DataTable<CisItem>
                data={rows}
                columns={columns}
                getRowId={(x) => x.id}
                primaryColumnId="title"
                caption={t('cis.items')}
                toolbar={
                  <div className="flex flex-wrap gap-2">
                    <Select
                      aria-label={t('cis.group')}
                      className="min-w-40"
                      value={group}
                      onValueChange={setGroup}
                      options={[
                        { value: ALL, label: t('cis.allGroups') },
                        ...GROUPS.map((g) => ({ value: g, label: t(`cis.groups.${g}`) })),
                      ]}
                    />
                    <Select
                      aria-label={t('sites.status')}
                      className="min-w-36"
                      value={status}
                      onValueChange={setStatus}
                      options={[
                        { value: ALL, label: t('cis.allStatus') },
                        ...(['fail', 'pass', 'na'] as const).map((s) => ({
                          value: s,
                          label: t(`common:status.${s}` as never) as string,
                        })),
                      ]}
                    />
                  </div>
                }
                empty={t('cis.noMatch')}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
