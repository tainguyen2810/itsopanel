import { useQuery } from '@tanstack/react-query';
import { Globe, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ListPage } from '@/shared/page/ListPage';
import { AppLink } from '@/ui/AppLink';
import { Badge } from '@/ui/Badge';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Switch } from '@/ui/Checkbox';
import type { ColumnDef } from '@/ui/DataTable';
import { DataTable } from '@/ui/DataTable';
import { StatCard } from '@/ui/StatCard';
import { list, send } from '../api';
import { useAction } from '../useAction';
import type { Website } from '../sites/common';
import { SecurityNav, useEventColumns } from './common';

/** WAF (ModSecurity + OWASP CRS) theo từng website PHP; cấu hình chi tiết ở tab WAF của website. */
export default function WafPage() {
  const { t } = useTranslation('admin');
  const events = useQuery({
    queryKey: ['admin', 'security', 'events', 'waf'],
    queryFn: async () =>
      (await list('/api/v1/admin/security/events')).filter((e) => e.type.startsWith('waf.')),
  });
  const sites = useQuery({
    queryKey: ['admin', 'websites', 'php'],
    queryFn: async () => (await list('/api/v1/admin/websites')).filter((w) => w.type === 'php'),
  });
  const toggle = useAction((w: Website) =>
    send('PATCH', '/api/v1/admin/websites/{id}/waf', {
      path: { id: w.uuid },
      body: { enabled: !w.waf_enabled },
    }),
  );
  const eventColumns = useEventColumns();
  const blocked = (w: Website) =>
    (events.data ?? []).filter((e) => e.website?.uuid === w.uuid).length;
  const on = (sites.data ?? []).filter((w) => w.waf_enabled).length;
  const columns: ColumnDef<Website, unknown>[] = [
    {
      id: 'site',
      header: t('sites.domain'),
      accessorKey: 'primary_domain',
      cell: ({ row }) => (
        <div className="min-w-0">
          <AppLink
            href={`/admin/websites/${row.original.uuid}?tab=waf`}
            className="font-medium break-all hover:underline"
          >
            {row.original.primary_domain}
          </AppLink>
          <p className="text-sm text-muted">{row.original.hosting_account.username}</p>
        </div>
      ),
    },
    { id: 'server', header: t('sites.server'), accessorFn: (w) => w.server.name },
    {
      id: 'events',
      header: t('sec.wafEvents'),
      accessorFn: blocked,
      cell: ({ getValue }) => <span className="tabular-nums">{getValue<number>()}</span>,
    },
    {
      id: 'waf',
      header: t('sec.wafState'),
      accessorFn: (w) => (w.waf_enabled ? 1 : 0),
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <Switch
            checked={row.original.waf_enabled}
            onCheckedChange={() => toggle.mutate(row.original)}
            disabled={toggle.isPending || row.original.status !== 'ready'}
            aria-label={t('sec.wafToggle', { name: row.original.primary_domain })}
          />
          {row.original.waf_enabled ? (
            <Badge tone="success">{t('sites.on')}</Badge>
          ) : (
            <Badge tone="warning">{t('sites.off')}</Badge>
          )}
        </span>
      ),
    },
  ];
  return (
    <>
      <ListPage<Website>
        title={t('sec.wafTitle')}
        description={t('sec.wafDescription')}
        nav={<SecurityNav current="waf" />}
        queryKey={['admin', 'websites', 'waf']}
        fetch={async (q) => {
          const rows = (await list('/api/v1/admin/websites', q)).filter((w) => w.type === 'php');
          return rows;
        }}
        columns={columns}
        getRowId={(w) => w.uuid}
        primaryColumnId="site"
      >
        <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
          <StatCard
            icon={Globe}
            label={t('sec.phpSites')}
            value={String(sites.data?.length ?? '—')}
          />
          <StatCard icon={ShieldCheck} tone="success" label={t('sec.wafOn')} value={String(on)} />
          <StatCard
            icon={ShieldOff}
            tone={(sites.data?.length ?? 0) - on > 0 ? 'warning' : 'success'}
            label={t('sec.wafOff')}
            value={String((sites.data?.length ?? 0) - on)}
            className="col-span-2 lg:col-span-1"
          />
        </div>
      </ListPage>
      <Card className="mt-6">
        <CardHeader title={t('sec.wafRecent')} description={t('sec.wafRecentHint')} />
        <CardContent>
          <DataTable
            data={events.data ?? []}
            columns={eventColumns}
            getRowId={(e) => e.uuid}
            primaryColumnId="message"
            caption={t('sec.wafRecent')}
          />
        </CardContent>
      </Card>
    </>
  );
}
