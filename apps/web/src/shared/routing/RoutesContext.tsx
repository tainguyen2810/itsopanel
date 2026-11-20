import { createContext, useContext } from 'react';
import type { Job } from '@/shared/jobs/JobDrawer';
import type { Realm } from '@/shared/session/personas';
import type { RouteDef } from './types';

export interface RoutesInfo {
  realm: Realm;
  basepath: string;
  defs: RouteDef[];
  /** Route trang chủ của khu vực (crumb đầu tiên). */
  homeId: string;
  /** Lấy job theo realm (admin/portal) cho drawer theo dõi job. */
  fetchJob: (uuid: string) => Promise<Job>;
}

export const RoutesContext = createContext<RoutesInfo | null>(null);

export function useRoutesInfo(): RoutesInfo {
  const v = useContext(RoutesContext);
  if (!v) throw new Error('useRoutesInfo cần RoutesContext');
  return v;
}
