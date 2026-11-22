import type { RouteDef } from '@/shared/routing/types';

/** Cây route User Hosting Portal theo docs/ui/sitemap.md mục B. */
export const PORTAL_ROUTES: RouteDef[] = [
  { id: 'login', path: '/login', bare: true },
  { id: 'loginMfa', path: '/login/mfa', bare: true },
  { id: 'forgotPassword', path: '/forgot-password', bare: true },
  { id: 'overview', path: '/', nav: 'overview' },
  { id: 'accountDetail', path: '/accounts/$id', nav: 'overview' },
  { id: 'websites', path: '/websites', nav: 'websites' },
  { id: 'websiteNew', path: '/websites/new', nav: 'websites' },
  { id: 'websiteDetail', path: '/websites/$id', nav: 'websites' },
  { id: 'databases', path: '/databases', nav: 'databases' },
  { id: 'files', path: '/files', nav: 'files' },
  { id: 'sftp', path: '/sftp', nav: 'sftp' },
  { id: 'cron', path: '/cron', nav: 'cron' },
  { id: 'backups', path: '/backups', nav: 'backups' },
  { id: 'wordpress', path: '/wordpress', nav: 'wordpress' },
  { id: 'wordpressDetail', path: '/wordpress/$id', nav: 'wordpress' },
  { id: 'terminal', path: '/terminal', nav: 'terminal' },
  { id: 'security', path: '/security', nav: 'security' },
  { id: 'jobDetail', path: '/jobs/$id' },
  { id: 'notifications', path: '/notifications', nav: 'notifications' },
  { id: 'profile', path: '/profile', nav: 'profile' },
];
