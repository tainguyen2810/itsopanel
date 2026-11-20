import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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

export interface Session {
  realm: Realm;
  user: Persona;
  /** Chế độ demo: cho phép chuyển người dùng mẫu. */
  demo: boolean;
  personas: Persona[];
  switchTo: (uuid: string) => void;
  can: (roles?: readonly Role[]) => boolean;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ realm, children }: { realm: Realm; children: ReactNode }) {
  const qc = useQueryClient();
  const uuid = useSyncExternalStore(
    subscribePersona,
    () => currentPersona(realm).uuid,
    () => currentPersona(realm).uuid,
  );
  const value = useMemo<Session>(() => {
    const user = PERSONAS[realm].find((p) => p.uuid === uuid) ?? currentPersona(realm);
    return {
      realm,
      user,
      demo: DEMO,
      personas: PERSONAS[realm],
      switchTo: (id) => {
        setPersona(realm, id);
        // Dữ liệu phụ thuộc phạm vi người dùng: xóa cache để tải lại theo vai trò mới.
        qc.clear();
      },
      can: (roles) => roles === undefined || roles.includes(user.role),
    };
  }, [realm, uuid, qc]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession cần SessionProvider');
  return s;
}
