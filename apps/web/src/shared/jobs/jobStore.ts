import { useSyncExternalStore } from 'react';

/** Job đang theo dõi trong drawer toàn cục (một job một lúc, job mới thay job cũ). */
let current: string | null = null;
let open = false;
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = { uuid: current, open };
  for (const l of listeners) l();
};
let snapshot: { uuid: string | null; open: boolean } = { uuid: null, open: false };

/** Mở drawer theo dõi job (gọi sau khi API trả 202 + JobAccepted). */
export function watchJob(uuid: string) {
  current = uuid;
  open = true;
  emit();
}

export function setJobDrawerOpen(v: boolean) {
  open = v;
  emit();
}

export function useJobDrawer() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => snapshot,
    () => snapshot,
  );
}
