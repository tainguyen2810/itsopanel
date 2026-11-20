import { useMemo, useState } from 'react';
import { RouterProvider, type RouterHistory } from '@tanstack/react-router';
import { SessionProvider } from '@/shared/session/SessionContext';
import type { Realm } from '@/shared/session/personas';
import { AppLinkContext } from '@/ui/AppLink';
import { AppLayout } from './AppLayout';
import { createAppRouter, routerLink, type PageLoaders } from './createAppRouter';
import { RoutesContext, type RoutesInfo } from './RoutesContext';
import type { RouteDef } from './types';

interface Props {
  realm: Realm;
  defs: RouteDef[];
  pages: PageLoaders;
  homeId: string;
  fetchJob: RoutesInfo['fetchJob'];
  search?: RoutesInfo['search'];
  history?: RouterHistory;
}

/** Entry có router: phiên (vai trò), bảng route, Link của router cho component nền. */
export function RoutedApp({ realm, defs, pages, homeId, fetchJob, search, history }: Props) {
  const basepath = `/${realm}`;
  const [router] = useState(() =>
    createAppRouter({ basepath, defs, pages, Layout: AppLayout, ...(history ? { history } : {}) }),
  );
  const info = useMemo<RoutesInfo>(
    () => ({ realm, basepath, defs, homeId, fetchJob, ...(search ? { search } : {}) }),
    [realm, basepath, defs, homeId, fetchJob, search],
  );
  const [link] = useState(() => routerLink(basepath));
  return (
    <SessionProvider realm={realm}>
      <RoutesContext.Provider value={info}>
        <AppLinkContext.Provider value={link}>
          <RouterProvider router={router} />
        </AppLinkContext.Provider>
      </RoutesContext.Provider>
    </SessionProvider>
  );
}
