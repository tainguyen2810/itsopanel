import { useEffect, useSyncExternalStore } from 'react';

/** Tên hiển thị của tham số route (uuid → tên server/website…) cho breadcrumb. */
const names = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

export function setCrumbName(id: string, name: string) {
  if (names.get(id) === name) return;
  names.set(id, name);
  version += 1;
  for (const l of listeners) l();
}

export function crumbName(id: string): string | undefined {
  return names.get(id);
}

export function useCrumbVersion(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => version,
    () => version,
  );
}

/** Trang chi tiết gọi để breadcrumb hiện tên thay cho uuid. */
export function useCrumbName(id: string | undefined, name: string | undefined) {
  useEffect(() => {
    if (id && name) setCrumbName(id, name);
  }, [id, name]);
}
