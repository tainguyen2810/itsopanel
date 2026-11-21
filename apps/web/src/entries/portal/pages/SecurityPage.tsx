import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ScanSearch, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { get, list, send } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { useFmt } from '@/shared/format/useFmt';
import { useFindingColumns } from '@/shared/hosting/pages/findings';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, PageSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { DataTable, type ColumnDef } from '@/ui/DataTable';
import { StatCard } from '@/ui/StatCard';

type Overview = Awaited<ReturnType<typeof fetchOverview>>;
type Acc = Overview['accounts'][number];
type Site = Acc['websites'][number];
type Finding = Awaited<ReturnType<typeof fetchFindings>>[number];
const fetchOverview = () => get('/protection');
const fetchFindings = () => list('/protection/findings');

/**
 * Bảo mật (Portal, D-78/D-79): WAF của website mình (chỉ xem; đổi chế độ do quản trị), quét mã độc account,
 * cách ly hoặc xóa file nghi nhiễm. Khôi phục file đã cách ly chỉ quản trị làm được.
 */
export default function SecurityPage() {
  const { t } = useTranslation('admin');
  const overview = useQuery({ queryKey: ['portal', 'protection'], queryFn: fetchOverview });
  const findings = useQuery({
    queryKey: ['portal', 'protection', 'findings'],
    queryFn: fetchFindings,
  });
  const [deleting, setDeleting] = useState<Finding | null>(null);
  const keys = [
    ['portal', 'protection'],
    ['portal', 'protection', 'findings'],
  ];
  const isolate = useAction(
    (f: Finding) => send('POST', '/protection/findings/{id}:quarantine', { path: { id: f.uuid } }),
    { success: t('sec.quarantining'), invalidate: keys },
  );
  const remove = useAction(
    (f: Finding) => send('DELETE', '/protection/findings/{id}', { path: { id: f.uuid } }),
    { invalidate: keys, onSuccess: () => setDeleting(null) },
  );
  const columns = useFindingColumns<Finding>(
    (f) => isolate.mutate(f),
    isolate.isPending,
    (f) => (
      <Button size="sm" variant="ghost" onClick={() => setDeleting(f)}>
        <Trash2 aria-hidden />
        {t('pt.deleteFile')}
      </Button>
    ),
  );
  return (
    <>
      <PageHeader title={t('pt.security')} description={t('pt.securityHint')} />
      {overview.isLoading && <PageSkeleton />}
      {overview.error && (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      )}
      <div className="flex flex-col gap-6">
        {overview.data?.accounts.map((a) => (
          <AccountCard key={a.hosting_account.uuid} acc={a} />
        ))}
        <Card>
          <CardHeader title={t('sec.findingsTitle')} description={t('pt.findingsHint')} />
          <CardContent>
            <DataTable
              data={findings.data ?? []}
              columns={columns}
              getRowId={(f) => f.uuid}
              primaryColumnId="path"
              caption={t('sec.findingsTitle')}
              empty={t('sec.findingsEmpty')}
            />
          </CardContent>
        </Card>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        tone="danger"
        title={t('pt.deleteFileTitle')}
        description={t('pt.deleteFileHint', { path: deleting?.path ?? '' })}
        confirmLabel={t('pt.deleteFile')}
        onConfirm={() =>
          deleting ? remove.mutateAsync(deleting).then(() => undefined) : undefined
        }
      />
    </>
  );
}

function AccountCard({ acc }: { acc: Acc }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const scan = useAction(
    () => send('POST', '/hosting-accounts/{id}/scans', { path: { id: acc.hosting_account.uuid } }),
    { success: t('pt.scanStarted'), invalidate: [['portal', 'protection']] },
  );
  const columns: ColumnDef<Site, unknown>[] = [
    {
      id: 'site',
      header: t('sites.domain'),
      accessorFn: (s) => s.website.primary_domain,
      cell: ({ row }) => (
        <span className="font-medium break-all">{row.original.website.primary_domain}</span>
      ),
    },
    {
      id: 'waf',
      header: t('pt.wafMode'),
      accessorFn: (s) => (s.waf_enabled ? s.waf_mode : 'off'),
      cell: ({ row }) =>
        !row.original.waf_enabled ? (
          <Badge tone="neutral">{t('pt.waf.off')}</Badge>
        ) : row.original.waf_mode === 'block' ? (
          <Badge tone="success">{t('pt.waf.block')}</Badge>
        ) : (
          <Badge tone="warning">{t('pt.waf.detect')}</Badge>
        ),
    },
    {
      id: 'blocked',
      header: t('pt.blocked24h'),
      accessorKey: 'blocked_24h',
      cell: ({ row }) => <span className="tabular-nums">{fmt.num(row.original.blocked_24h)}</span>,
    },
  ];
  return (
    <Card>
      <CardHeader
        title={acc.hosting_account.username}
        description={
          acc.last_scan_at
            ? t('pt.lastScan', { at: fmt.rel(acc.last_scan_at) })
            : t('pt.neverScanned')
        }
        action={
          <Button
            variant="outline"
            onClick={() => scan.mutate()}
            disabled={scan.isPending || acc.scan_running}
          >
            <ScanSearch aria-hidden />
            {acc.scan_running ? t('pt.scanning') : t('pt.scanAccount')}
          </Button>
        }
      />
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <StatCard
            icon={ShieldCheck}
            tone={acc.findings_open > 0 ? 'danger' : 'success'}
            label={t('pt.findingsOpen')}
            value={String(acc.findings_open)}
            hint={acc.findings_open > 0 ? t('pt.findingsOpenHint') : t('sec.clean')}
          />
          <StatCard
            icon={ShieldCheck}
            tone="primary"
            label={t('pt.blocked24h')}
            value={fmt.num(acc.websites.reduce((n, w) => n + w.blocked_24h, 0))}
            hint={t('pt.blockedHint')}
          />
        </div>
        <DataTable
          data={acc.websites}
          columns={columns}
          getRowId={(w) => w.website.uuid}
          primaryColumnId="site"
          caption={t('pt.wafTable')}
          empty={t('pt.noPhpSites')}
        />
        <Alert tone="info" title={t('pt.wafNoteTitle')}>
          {t('pt.wafNote')}
        </Alert>
      </CardContent>
    </Card>
  );
}
