import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ApiError } from '@/api/http';
import { quotaResource } from '@/shared/jobs/jobErrors';

/**
 * Thông báo lỗi từ Problem (detail ưu tiên hơn title). Có `t`: vượt giới hạn gói (quota_exceeded)
 * được diễn giải theo tài nguyên của gói, kèm số liệu API trả về.
 */
export function errorText(e: unknown, t?: TFunction<'common'>): string {
  if (e instanceof ApiError) {
    const p = e.problem;
    if (t && p.code === 'quota_exceeded') {
      const res = quotaResource((p as { errors?: unknown }).errors);
      return t('problems.quota', {
        resource: res
          ? t(`problems.quotaResource.${res}` as never)
          : t('problems.quotaResource.other'),
        detail: p.detail ?? '',
      });
    }
    return p.detail ?? p.title;
  }
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
  const { t } = useTranslation('common');
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.success) toast.success(opts.success);
      for (const k of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: k });
      opts.onSuccess?.(r, v);
    },
    onError: (e) => toast.error(errorText(e, t)),
  });
}
