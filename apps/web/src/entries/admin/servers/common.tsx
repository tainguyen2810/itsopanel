import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useCrumbName } from '@/shared/routing/crumbs';
import { useSession } from '@/shared/session/SessionContext';
import { AppLink } from '@/ui/AppLink';
import { cn } from '@/shared/lib/utils';
import { get } from '../api';

export function useServerId(): string {
  return (useParams({ strict: false }) as { id: string }).id;
}

/** Server hiện tại (theo $id) + tên cho breadcrumb. */
export function useServer() {
  const id = useServerId();
  const q = useQuery({
    queryKey: ['admin', 'server', id],
    queryFn: () => get('/api/v1/admin/servers/{id}', { path: { id } }),
  });
  useCrumbName(id, q.data?.name);
  return { id, ...q };
}

const SECTIONS = [
  { key: 'overview', path: '' },
  { key: 'nginx', path: '/nginx' },
  { key: 'php', path: '/php' },
  { key: 'software', path: '/software' },
  { key: 'firewall', path: '/firewall' },
  { key: 'docker', path: '/docker' },
  { key: 'terminal', path: '/terminal', sa: true },
] as const;

/** Thanh chuyển giữa các trang cấu hình của một server. */
export function ServerNav({ current }: { current: (typeof SECTIONS)[number]['key'] }) {
  const { t } = useTranslation('admin');
  const id = useServerId();
  const { user } = useSession();
  return (
    <nav
      aria-label={t('servers.sections')}
      className="-mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"
    >
      <ul className="flex gap-1 border-b border-border">
        {SECTIONS.filter((s) => !('sa' in s) || user.role === 'SUPER_ADMIN').map((s) => (
          <li key={s.key}>
            <AppLink
              href={`/admin/servers/${id}${s.path}`}
              aria-current={current === s.key ? 'page' : undefined}
              className={cn(
                'block rounded-md px-3 py-1.5 text-base whitespace-nowrap',
                current === s.key
                  ? 'bg-surface font-medium text-fg shadow-sm'
                  : 'text-muted hover:bg-surface-hover hover:text-fg',
              )}
            >
              {t(`servers.nav.${s.key}`)}
            </AppLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
