import type { TFunction } from 'i18next';
import type { Realm } from '@/shared/session/personas';

/** "hosting_account.create" → "Hosting account create" (khi chưa có bản dịch). */
export function humanize(key: string): string {
  const s = key.replace(/[._:]/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Nhãn hành động audit/loại job: common:events.<a.b> (lồng theo dấu chấm), mặc định tự sinh. */
export function auditLabel(t: TFunction<'admin'>, action: string): string {
  return t(`common:events.${action}` as never, { defaultValue: humanize(action) }) as string;
}

/** Trang chi tiết theo loại tài nguyên; Portal chỉ có account, website, job. */
const PAGES: Record<Realm, Record<string, string>> = {
  admin: {
    server: '/admin/servers/',
    hosting_account: '/admin/hosting-accounts/',
    hosting_package: '/admin/hosting-packages/',
    website: '/admin/websites/',
    user: '/admin/users/',
    compose_project: '/admin/compose-projects/',
    job: '/admin/jobs/',
  },
  portal: {
    hosting_account: '/portal/accounts/',
    website: '/portal/websites/',
    job: '/portal/jobs/',
  },
};

/** Đường dẫn trang chi tiết của tài nguyên (ResourceRef), nếu realm có trang đó. */
export function resourceHref(
  r: { type: string; uuid: string } | null | undefined,
  realm: Realm = 'admin',
): string | null {
  if (!r) return null;
  const b = PAGES[realm][r.type];
  return b ? b + r.uuid : null;
}
