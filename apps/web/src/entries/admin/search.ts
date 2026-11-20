import type { TFunction } from 'i18next';
import type { SearchGroup } from '@/shared/shell/CommandPalette';
import { currentPersona } from '@/shared/session/personas';
import { list } from './api';

/**
 * Ctrl+K: tìm trên server, account, website, user bằng tham số `q` của các API danh sách
 * (API áp phạm vi theo vai trò; ADMIN không thấy user nên bỏ nhóm user).
 */
export function createSearch(t: TFunction<'admin'>) {
  return async (q: string): Promise<SearchGroup[]> => {
    const query = { q, filters: {} };
    const sa = currentPersona('admin').role === 'SUPER_ADMIN';
    const [servers, accounts, websites, users] = await Promise.all([
      list('/api/v1/admin/servers', query),
      list('/api/v1/admin/hosting-accounts', query),
      list('/api/v1/admin/websites', query),
      sa ? list('/api/v1/admin/users', query) : Promise.resolve([]),
    ]);
    const top = <T>(xs: T[]) => xs.slice(0, 5);
    return [
      {
        key: 'servers',
        label: t('search.servers'),
        hits: top(servers).map((s) => ({
          id: s.uuid,
          label: s.name,
          sub: s.ip_addresses.at(-1) ?? s.hostname,
          href: `/admin/servers/${s.uuid}`,
        })),
      },
      {
        key: 'accounts',
        label: t('search.accounts'),
        hits: top(accounts).map((a) => ({
          id: a.uuid,
          label: a.username,
          sub: `${a.owner.name} · ${a.server.name}`,
          href: `/admin/hosting-accounts/${a.uuid}`,
        })),
      },
      {
        key: 'websites',
        label: t('search.websites'),
        hits: top(websites).map((w) => ({
          id: w.uuid,
          label: w.primary_domain,
          sub: w.hosting_account.username,
          href: `/admin/websites/${w.uuid}`,
        })),
      },
      {
        key: 'users',
        label: t('search.users'),
        hits: top(users).map((u) => ({
          id: u.uuid,
          label: u.name,
          sub: u.email,
          href: `/admin/users/${u.uuid}`,
        })),
      },
    ];
  };
}
