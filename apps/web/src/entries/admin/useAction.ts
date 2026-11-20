import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError } from '@/api/http';

/** Thông báo lỗi từ Problem (detail ưu tiên hơn title). */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.problem.detail ?? e.problem.title;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Mutation cho thao tác ghi: toast lỗi theo Problem, toast thành công (nếu có), làm mới các query
 * liên quan. Thao tác trả 202 đã tự mở drawer theo dõi job (xem `send`).
 */
export function useAction<V = void, R = unknown>(
  fn: (v: V) => Promise<R>,
  opts: { success?: string; invalidate?: QueryKey[]; onSuccess?: (r: R, v: V) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.success) toast.success(opts.success);
      for (const k of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: k });
      opts.onSuccess?.(r, v);
    },
    onError: (e) => toast.error(errorText(e)),
  });
}
