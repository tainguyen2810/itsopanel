import { Outlet, useNavigate } from '@tanstack/react-router';
import { JobDrawerHost } from '@/shared/jobs/JobDrawer';
import { useSession } from '@/shared/session/SessionContext';
import { AdminShell, PortalShell } from '@/shared/shell/AppShell';
import { useRoutesInfo } from './RoutesContext';
import { useCurrentRoute } from './useBreadcrumbs';

/** Layout có shell cho mọi route không phải `bare`: sidebar active theo route, drawer job toàn cục. */
export function AppLayout() {
  const session = useSession();
  const { fetchJob, search, basepath } = useRoutesInfo();
  const { def } = useCurrentRoute();
  const navigate = useNavigate();
  const Shell = session.realm === 'admin' ? AdminShell : PortalShell;
  const { user } = session;
  return (
    <Shell
      activeKey={def?.nav ?? ''}
      user={{ name: user.name, email: user.email, roleLabel: user.label }}
      unread={session.realm === 'admin' ? 3 : 1}
      {...(session.demo
        ? { demo: { current: user.uuid, personas: session.personas, onSwitch: session.switchTo } }
        : {})}
      onOpenProfile={() => void navigate({ to: '/profile' })}
      onOpenNotifications={() => void navigate({ to: '/notifications' })}
      onSignOut={() => void navigate({ to: '/login' })}
      overlay={<JobDrawerHost fetchJob={fetchJob} />}
      {...(search ? { searchFn: search } : {})}
      onNavigate={(href) => void navigate({ to: href.slice(basepath.length) || '/' })}
    >
      <Outlet />
    </Shell>
  );
}
