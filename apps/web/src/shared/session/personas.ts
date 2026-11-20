import { readStorage, writeStorage } from '@/shared/lib/storage';

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'USER';
export type Realm = 'admin' | 'portal';

export interface Persona {
  uuid: string;
  name: string;
  email: string;
  role: Role;
  /** Nhãn ngắn hiển thị ở topbar (vai trò hoặc username hosting). */
  label: string;
}

/**
 * Người dùng mẫu (khớp contracts/examples/demo-dataset.json). Ở chế độ demo có thể chuyển vai trò;
 * build thường dùng người đầu tiên của mỗi realm tới khi có đăng nhập thật (Phase 3).
 */
export const PERSONAS: Record<Realm, Persona[]> = {
  admin: [
    {
      uuid: '01938a01-0001-7000-8000-000001000001',
      name: 'Quản trị hệ thống',
      email: 'superadmin@itso.local',
      role: 'SUPER_ADMIN',
      label: 'Super Admin',
    },
    {
      uuid: '01938a01-0002-7000-8000-000001000002',
      name: 'Trần Minh',
      email: 'minh.tran@itso.local',
      role: 'ADMIN',
      label: 'Admin',
    },
    {
      uuid: '01938a01-000e-7000-8000-00000100000e',
      name: 'Nguyễn Hải',
      email: 'hai.nguyen@itso.local',
      role: 'SUPER_ADMIN',
      label: 'Super Admin',
    },
  ],
  portal: [
    {
      uuid: '01938a01-0003-7000-8000-000001000003',
      name: 'Công ty An Phát',
      email: 'it@anphat.vn',
      role: 'USER',
      label: 'anphat',
    },
    {
      uuid: '01938a01-0004-7000-8000-000001000004',
      name: 'Phòng Marketing',
      email: 'marketing@itso.vn',
      role: 'USER',
      label: 'mktitso',
    },
    {
      uuid: '01938a01-0005-7000-8000-000001000005',
      name: 'Lê Hoa',
      email: 'hoa.le@example.vn',
      role: 'USER',
      label: 'lehoa',
    },
  ],
};

const KEY = (realm: Realm) => `itso.demo.actor.${realm}`;
const listeners = new Set<() => void>();

/** Người dùng demo đang chọn của realm (mặc định người đầu tiên). */
export function currentPersona(realm: Realm): Persona {
  const want = readStorage(KEY(realm));
  const list = PERSONAS[realm];
  return list.find((p) => p.uuid === want) ?? (list[0] as Persona);
}

export function setPersona(realm: Realm, uuid: string) {
  writeStorage(KEY(realm), uuid);
  for (const l of listeners) l();
}

export function subscribePersona(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
