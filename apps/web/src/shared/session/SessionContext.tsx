import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/api/http';
import { UNAUTHENTICATED_EVENT } from '@/api/realm-http';
import { getAuth, sendAuth } from '@/shared/api/realm';
import { DEMO } from '@/shared/demoMode';
import {
  currentPersona,
  PERSONAS,
  setPersona,
  subscribePersona,
  type Persona,
  type Realm,
  type Role,
} from './personas';

/**
 * - `loading`: đang hỏi `/auth/me`.
 * - `anonymous`: chưa đăng nhập (shell chuyển về /login).
 * - `mfa`: đã qua mật khẩu nhưng chưa xác minh MFA (shell chuyển về /login/mfa).
 * - `enroll`: SUPER_ADMIN chưa bật MFA (chỉ vào được Hồ sơ để bật).
 * - `ready`: dùng được.
 */
export type SessionStatus = 'loading' | 'anonymous' | 'mfa' | 'enroll' | 'ready';

export interface Session {
  realm: Realm;
  /** Người đang đăng nhập (khi chưa đăng nhập: giá trị rỗng, xem `status`). */
  user: Persona;
  status: SessionStatus;
  /** Chế độ demo: cho phép chuyển người dùng mẫu. */
  demo: boolean;
  personas: Persona[];
  switchTo: (uuid: string) => void;
  can: (roles?: readonly Role[]) => boolean;
  /** Đăng xuất (API thật) rồi về trang đăng nhập. */
  signOut: () => Promise<void>;
  /** Tải lại `/auth/me` (sau đăng nhập, xác minh MFA). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

/** Người dùng mẫu thay cho phiên thật: chế độ demo (MSW) và unit test (Vitest). */
const PERSONA_MODE = DEMO || import.meta.env.MODE === 'test';

const LABEL: Record<Role, string> = { SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', USER: 'User' };
const NOBODY: Persona = { uuid: '', name: '', email: '', role: 'USER', label: '' };

interface Me {
  user: { uuid: string; name: string; email: string; role: Role; mfa_enabled: boolean };
  mfa_verified_at: string | null;
}

/** Phiên thật: `/auth/me` theo realm (cookie phiên `itso_{realm}_session`). */
function useRealSession(realm: Realm) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    enabled: !PERSONA_MODE,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<Me | null> => {
      try {
        return (await getAuth('/api/v1/auth/me')) as Me;
      } catch (e) {
        if (e instanceof ApiError && e.problem.status === 401) return null;
        throw e;
      }
    },
  });
  useEffect(() => {
    if (PERSONA_MODE) return;
    const on = () => void qc.setQueryData(['me'], null);
    globalThis.addEventListener(UNAUTHENTICATED_EVENT, on);
    return () => globalThis.removeEventListener(UNAUTHENTICATED_EVENT, on);
  }, [qc]);
  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    await qc.refetchQueries({ queryKey: ['me'] });
  }, [qc]);
  const signOut = useCallback(async () => {
    try {
      await sendAuth('POST', '/api/v1/auth/logout');
    } finally {
      qc.clear();
      qc.setQueryData(['me'], null);
    }
  }, [qc]);
  const { data, isError } = me;
  const derived = useMemo((): { status: SessionStatus; user: Persona } => {
    if (isError || data === null) return { status: 'anonymous', user: NOBODY };
    if (!data) return { status: 'loading', user: NOBODY };
    const u = data.user;
    const user = { uuid: u.uuid, name: u.name, email: u.email, role: u.role, label: LABEL[u.role] };
    if (data.mfa_verified_at) return { status: 'ready', user };
    if (u.mfa_enabled) return { status: 'mfa', user };
    if (realm === 'admin' && u.role === 'SUPER_ADMIN') return { status: 'enroll', user };
    return { status: 'ready', user };
  }, [data, isError, realm]);
  const { status, user } = derived;
  return { status, user, refresh, signOut };
}

export function SessionProvider({ realm, children }: { realm: Realm; children: ReactNode }) {
  const qc = useQueryClient();
  const uuid = useSyncExternalStore(
    subscribePersona,
    () => currentPersona(realm).uuid,
    () => currentPersona(realm).uuid,
  );
  const real = useRealSession(realm);
  const value = useMemo<Session>(() => {
    const user = PERSONA_MODE
      ? (PERSONAS[realm].find((p) => p.uuid === uuid) ?? currentPersona(realm))
      : real.user;
    return {
      realm,
      user,
      status: PERSONA_MODE ? 'ready' : real.status,
      demo: DEMO,
      personas: PERSONA_MODE ? PERSONAS[realm] : [],
      switchTo: (id) => {
        setPersona(realm, id);
        // Dữ liệu phụ thuộc phạm vi người dùng: bỏ dữ liệu cũ và tải lại theo người dùng mới.
        // (clear() chỉ xóa cache, trang đang mở vẫn giữ dữ liệu của người trước tới khi remount.)
        void qc.resetQueries();
      },
      can: (roles) => roles === undefined || roles.includes(user.role),
      signOut: PERSONA_MODE ? async () => undefined : real.signOut,
      refresh: PERSONA_MODE ? async () => undefined : real.refresh,
    };
  }, [realm, uuid, qc, real.user, real.status, real.signOut, real.refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession cần SessionProvider');
  return s;
}
