import type { TFunction } from 'i18next';

/** "hosting_account.create" → "Hosting account create" (khi chưa có bản dịch). */
export function humanize(key: string): string {
  const s = key.replace(/[._:]/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Nhãn hành động audit/loại job: common:events.<a.b> (lồng theo dấu chấm), mặc định tự sinh. */
export function auditLabel(t: TFunction<'admin'>, action: string): string {
  return t(`common:events.${action}` as never, { defaultValue: humanize(action) }) as string;
}

/** Đường dẫn trang chi tiết của tài nguyên (ResourceRef), nếu có trang. */
export function resourceHref(r: { type: string; uuid: string } | null | undefined): string | null {
  if (!r) return null;
  const base: Record<string, string> = {
    server: '/admin/servers/',
    hosting_account: '/admin/hosting-accounts/',
    hosting_package: '/admin/hosting-packages/',
    website: '/admin/websites/',
    user: '/admin/users/',
    compose_project: '/admin/compose-projects/',
    job: '/admin/jobs/',
  };
  const b = base[r.type];
  return b ? b + r.uuid : null;
}
