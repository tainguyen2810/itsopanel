import { useTranslation } from 'react-i18next';
import { useSession } from '@/shared/session/SessionContext';
import { SectionNav } from '@/shared/page/SectionNav';
import { Badge, SeverityBadge, type Severity } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { useFmt } from '@/shared/format/useFmt';
import { AppLink } from '@/ui/AppLink';
import { send, type Row } from '../api';
import { useAction } from '../useAction';

const SECTIONS = [
  { key: 'overview', path: '' },
  { key: 'waf', path: '/waf' },
  { key: 'malware', path: '/malware' },
  { key: 'ssh', path: '/ssh', sa: true },
  { key: 'fail2ban', path: '/fail2ban', sa: true },
  { key: 'fim', path: '/fim', sa: true },
  { key: 'allowlist', path: '/allowlist', sa: true },
  { key: 'terminal', path: '/terminal', sa: true },
  { key: 'cis', path: '/cis' },
] as const;
export type Section = (typeof SECTIONS)[number]['key'];

/** Các mục của Bảo mật; mục cấu hình máy chủ chỉ Super Admin thấy. */
export function SecurityNav({ current }: { current: Section }) {
  const { t } = useTranslation('admin');
  const { user } = useSession();
  return (
    <SectionNav
      label={t('sec.sections')}
      current={current}
      items={SECTIONS.filter((s) => !('sa' in s) || user.role === 'SUPER_ADMIN').map((s) => ({
        key: s.key,
        href: `/admin/security${s.path}`,
        label: t(`sec.nav.${s.key}`),
      }))}
    />
  );
}

export type SecEvent = Row<'/api/v1/admin/security/events'>;

/** Cột chung cho bảng sự kiện bảo mật (dùng ở Tổng quan, WAF, FIM). */
export function useEventColumns(): ColumnDef<SecEvent, unknown>[] {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const ack = useAction(
    (e: SecEvent) =>
      send('POST', '/api/v1/admin/security/events/{id}:acknowledge', { path: { id: e.uuid } }),
    { success: t('sec.acked'), invalidate: [['admin', 'security']] },
  );
  return [
    {
      id: 'at',
      header: t('sec.at'),
      accessorKey: 'at',
      cell: ({ row }) => <span className="whitespace-nowrap">{fmt.rel(row.original.at)}</span>,
    },
    {
      id: 'severity',
      header: t('sec.severity'),
      accessorKey: 'severity',
      cell: ({ row }) => <SeverityBadge severity={row.original.severity as Severity} />,
    },
    {
      id: 'message',
      header: t('sec.message'),
      accessorKey: 'message',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="wrap-anywhere">{row.original.message}</p>
          <p className="flex flex-wrap gap-x-2 text-sm text-muted">
            <span>
              {t(`sec.types.${row.original.type}` as never, { defaultValue: row.original.type })}
            </span>
            <span>{row.original.server.name}</span>
            {row.original.website && (
              <AppLink
                href={`/admin/websites/${row.original.website.uuid}`}
                className="hover:underline"
              >
                {row.original.website.primary_domain}
              </AppLink>
            )}
            {row.original.source_ip && <span className="font-mono">{row.original.source_ip}</span>}
          </p>
        </div>
      ),
    },
    {
      id: 'ack',
      header: t('sec.handled'),
      accessorFn: (e) => (e.acknowledged_at ? 1 : 0),
      cell: ({ row }) =>
        row.original.acknowledged_at ? (
          <Badge tone="success">
            {t('sec.ackedAt', { at: fmt.rel(row.original.acknowledged_at) })}
          </Badge>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => ack.mutate(row.original)}
            disabled={ack.isPending}
            aria-label={t('sec.ackFor', { msg: row.original.message })}
          >
            {t('sec.ack')}
          </Button>
        ),
    },
  ];
}
