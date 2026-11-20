import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import type { AppLinkProps } from '@/ui/AppLink';
import { useSession } from '@/shared/session/SessionContext';
import { ErrorState, ForbiddenPage, NotFoundPage, PageSkeleton } from '@/shared/page/states';
import { PlaceholderPage } from '@/shared/page/PlaceholderPage';
import type { RouteDef } from './types';

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    def?: RouteDef;
  }
}

export type PageModule = Promise<{ default: ComponentType }>;
export type PageLoaders = Partial<Record<string, () => PageModule>>;

interface Options {
  basepath: string;
  defs: RouteDef[];
  /** id route → import động của trang (code-split). Route chưa có trang dùng PlaceholderPage. */
  pages: PageLoaders;
  /** Layout có shell (sidebar, topbar); render <Outlet/>. */
  Layout: ComponentType;
  history?: RouterHistory;
}

/** Chặn vai trò không được phép: hiện trang 403 thân thiện thay vì nội dung. */
export function RoleGuard({ def, children }: { def: RouteDef; children: React.ReactNode }) {
  const { can } = useSession();
  return can(def.roles) ? children : <ForbiddenPage />;
}

/** Tạo router (code-based) từ bảng route của sitemap. */
export function createAppRouter({ basepath, defs, pages, Layout, history }: Options) {
  const lazies = new Map<string, LazyExoticComponent<ComponentType>>();
  for (const d of defs) {
    const load = pages[d.id];
    if (load) lazies.set(d.id, lazy(load));
  }

  const root = createRootRoute({ component: Outlet, notFoundComponent: NotFoundPage });
  const shell = createRoute({
    getParentRoute: () => root,
    id: 'shell',
    component: () => <Layout />,
  });

  const make = (d: RouteDef) => {
    const Page = lazies.get(d.id);
    const target = d.redirect;
    return createRoute({
      getParentRoute: () => (d.bare ? root : shell),
      path: d.path,
      staticData: { def: d },
      ...(target !== undefined
        ? {
            beforeLoad: () => {
              throw redirect({ to: target, replace: true });
            },
          }
        : {}),
      component: function RoutePage() {
        return (
          <RoleGuard def={d}>
            <Suspense fallback={<PageSkeleton />}>{Page ? <Page /> : <PlaceholderPage />}</Suspense>
          </RoleGuard>
        );
      },
    });
  };

  const tree = root.addChildren([
    shell.addChildren(defs.filter((d) => !d.bare).map(make)),
    ...defs.filter((d) => d.bare).map(make),
  ]);

  return createRouter({
    routeTree: tree,
    basepath,
    defaultPreload: 'intent',
    defaultErrorComponent: ({ error, reset }) => <ErrorState error={error} onRetry={reset} />,
    scrollRestoration: true,
    ...(history ? { history } : {}),
  });
}

/** AppLink dùng Link của router: nhận href đầy đủ (gồm basepath) như thẻ <a>. */
export function routerLink(basepath: string) {
  return function RouterLink({ href, ...rest }: AppLinkProps) {
    if (!href.startsWith(basepath)) return <a href={href} {...rest} />;
    const to = href.slice(basepath.length) || '/';
    return <Link to={to} {...(rest as Record<string, unknown>)} />;
  };
}
