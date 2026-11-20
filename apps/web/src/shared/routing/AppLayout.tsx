import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, useNavigate } from '@tanstack/react-router';
import { list } from '@/shared/api/realm';
import { JobDrawerHost } from '@/shared/jobs/JobDrawer';
import { PageSkeleton } from '@/shared/page/states';
import { useSession } from '@/shared/session/SessionContext';
import { AdminShell, PortalShell } from '@/shared/shell/AppShell';
import { useRoutesInfo } from './RoutesContext';
import { useCurrentRoute } from './useBreadcrumbs';

/**
 * Layout có shell cho mọi route không phải `bare`: sidebar active theo route, drawer job toàn cục.
 * API thật: chưa đăng nhập → /login, chưa xác minh MFA → /login/mfa, SUPER_ADMIN chưa bật MFA → chỉ /profile.
 */
export function AppLayout() {
  const session = useSession();
  const { def } = useCurrentRoute();
  if (session.status === 'loading') return <PageSkeleton />;
  if (session.status === 'anonymous') return <Navigate to="/login" replace />;
  if (session.status === 'mfa') return <Navigate to="/login/mfa" replace />;
  if (session.status === 'enroll' && def?.id !== 'profile')
    return <Navigate to="/profile" replace />;
  return <ShellLayout />;
}

function ShellLayout() {
  const session = useSession();
  const { fetchJob, search, basepath } = useRoutesInfo();
  const { def } = useCurrentRoute();
  const navigate = useNavigate();
  const Shell = session.realm === 'admin' ? AdminShell : PortalShell;
  const { user } = session;
  // Số thông báo chưa đọc của người đang đăng nhập (cùng key với trang Thông báo nên đánh dấu
  // đã đọc ở đó cập nhật ngay chuông trên topbar).
  const notes = useQuery({
    queryKey: ['admin', 'notifications'],
    queryFn: () => list('/notifications'),
  });
  const unread = (notes.data ?? []).filter((n) => n.read_at === null).length;
  return (
    <Shell
      activeKey={def?.nav ?? ''}
      user={{ name: user.name, email: user.email, roleLabel: user.label }}
      unread={unread}
      {...(session.demo
        ? { demo: { current: user.uuid, personas: session.personas, onSwitch: session.switchTo } }
        : {})}
      onOpenProfile={() => void navigate({ to: '/profile' })}
      onOpenNotifications={() => void navigate({ to: '/notifications' })}
      onSignOut={() => void session.signOut().finally(() => void navigate({ to: '/login' }))}
      overlay={<JobDrawerHost fetchJob={fetchJob} />}
      {...(search ? { searchFn: search } : {})}
      onNavigate={(href) => void navigate({ to: href.slice(basepath.length) || '/' })}
    >
      <Outlet />
    </Shell>
  );
}
