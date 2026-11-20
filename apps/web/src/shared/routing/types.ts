import type { Role } from '@/shared/session/personas';

/**
 * Một route của sitemap (docs/ui/sitemap.md). Dữ liệu thuần (không import component) để
 * test smoke và breadcrumb dùng chung.
 */
export interface RouteDef {
  /** Khóa ổn định; tiêu đề trang là `pages:<realm>.<id>`. */
  id: string;
  /** Đường dẫn TanStack Router, tương đối với basepath (`/admin`, `/portal`). */
  path: string;
  /** Vai trò được vào; bỏ trống = mọi vai trò của realm. */
  roles?: readonly Role[];
  /** Mục sidebar được đánh dấu active. */
  nav?: string;
  /** Trang không có shell (đăng nhập, cài đặt lần đầu). */
  bare?: boolean;
  /** Chuyển hướng (route chỉ để điều hướng). */
  redirect?: string;
}

export const SA = ['SUPER_ADMIN'] as const;
