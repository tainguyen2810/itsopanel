/** Danh mục quyền hiển thị trên ma trận vai trò (khóa dạng "<tài nguyên>.<hành động>"). */
export const PERMISSION_GROUPS = [
  { key: 'servers', actions: ['read', 'write'] },
  { key: 'packages', actions: ['read', 'write'] },
  { key: 'accounts', actions: ['read', 'write'] },
  { key: 'websites', actions: ['read', 'write'] },
  { key: 'databases', actions: ['read', 'write'] },
  { key: 'backups', actions: ['read', 'write', 'restore'] },
  { key: 'security', actions: ['read', 'write'] },
  { key: 'users', actions: ['read', 'write'] },
  { key: 'settings', actions: ['read', 'write'] },
  { key: 'audit', actions: ['read'] },
  { key: 'own', actions: ['read', 'write'] },
] as const;

export type PermissionKey = `${(typeof PERMISSION_GROUPS)[number]['key']}.${string}`;

export const PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) =>
  g.actions.map((a) => `${g.key}.${a}`),
);

/**
 * Vai trò có quyền `key` không: "*" là mọi quyền; "websites.*" là mọi hành động trên websites;
 * còn lại so khớp chính xác (không suy diễn write ⇒ read).
 */
export function allows(perms: readonly string[], key: string): boolean {
  return perms.some((p) => {
    if (p === '*' || p === key) return true;
    if (p.endsWith('.*')) return key.startsWith(p.slice(0, -1));
    return false;
  });
}

/** Ma trận quyền: hàng = quyền, cột = vai trò. */
export function permissionMatrix(
  roles: readonly { key: string; permissions: readonly string[] }[],
) {
  return PERMISSIONS.map((perm) => ({
    perm,
    cells: roles.map((r) => ({ role: r.key, allowed: allows(r.permissions, perm) })),
  }));
}
