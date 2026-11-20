import { useMatches } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { Crumb } from '@/ui/Navigation';
import { crumbName, useCrumbVersion } from './crumbs';
import { useRoutesInfo } from './RoutesContext';
import type { RouteDef } from './types';

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/** Tiêu đề i18n của route: pages:<realm>.<id>. */
export function useRouteTitle() {
  const { t } = useTranslation('pages');
  const { realm } = useRoutesInfo();
  return (def: RouteDef) => t(`${realm}.${def.id}` as 'admin.dashboard');
}

/** Route hiện tại (def + params) từ match cuối cùng có staticData. */
export function useCurrentRoute(): { def: RouteDef | undefined; params: Record<string, string> } {
  const matches = useMatches();
  const m = [...matches].reverse().find((x) => x.staticData.def !== undefined);
  return { def: m?.staticData.def, params: (m?.params ?? {}) as Record<string, string> };
}

/**
 * Breadcrumb tự sinh từ đường dẫn route: mỗi tiền tố của path là một route trong sitemap
 * (`/servers` → `/servers/$id` → `/servers/$id/nginx`). Tham số hiện tên nếu trang đã đăng ký.
 */
export function useBreadcrumbs(currentLabel?: string): Crumb[] {
  useCrumbVersion();
  const { defs, homeId, basepath } = useRoutesInfo();
  const title = useRouteTitle();
  const { def, params } = useCurrentRoute();
  if (!def) return [];
  const byPath = new Map(defs.map((d) => [d.path, d]));
  const fill = (p: string) => p.replace(/\$(\w+)/g, (_, k: string) => params[k] ?? '');
  const segs = def.path.split('/').filter(Boolean);
  const crumbs: Crumb[] = [];
  const home = defs.find((d) => d.id === homeId);
  if (home && home.id !== def.id) crumbs.push({ label: title(home), href: basepath + home.path });
  for (let i = 1; i <= segs.length; i++) {
    const path = `/${segs.slice(0, i).join('/')}`;
    const d = byPath.get(path);
    if (!d || d.redirect) continue;
    const last = i === segs.length;
    const seg = segs[i - 1] ?? '';
    const label = seg.startsWith('$')
      ? (crumbName(params[seg.slice(1)] ?? '') ?? shortId(params[seg.slice(1)] ?? ''))
      : title(d);
    crumbs.push(
      last
        ? { label: currentLabel ?? label }
        : { label, href: basepath + fill(path).replace(/\/$/, '') },
    );
  }
  return crumbs;
}
