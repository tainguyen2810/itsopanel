import { z } from 'zod';
import type { Data } from '../api';

export type Package = Data<'/api/v1/admin/hosting-packages/{id}'>;
export type Limits = Package['limits'];

/** Phiên bản PHP có thể chọn cho gói (khớp `software` của agent ở Phase 1). */
export const PHP_VERSIONS = ['7.4', '8.1', '8.2', '8.3', '8.4'] as const;

type NumKey = {
  [K in keyof Limits]: Limits[K] extends number ? K : never;
}[keyof Limits];

/** Ô số của form giới hạn: nhóm hiển thị, giá trị nhỏ nhất, đơn vị (để định dạng). */
export const LIMIT_GROUPS: {
  key: 'resources' | 'web' | 'data';
  fields: { name: NumKey; min: number; max?: number; unit?: 'mb' | 'pct' | 'min' }[];
}[] = [
  {
    key: 'resources',
    fields: [
      { name: 'disk_mb', min: 1, unit: 'mb' },
      { name: 'inode_limit', min: 1 },
      { name: 'cpu_percent', min: 1, max: 6400, unit: 'pct' },
      { name: 'ram_mb', min: 64, unit: 'mb' },
      { name: 'tasks_max', min: 1 },
      { name: 'php_workers_max', min: 1, max: 256 },
      { name: 'io_weight', min: 1, max: 10000 },
    ],
  },
  {
    key: 'web',
    fields: [
      { name: 'website_limit', min: 0 },
      { name: 'alias_domain_limit', min: 0 },
      { name: 'subdomain_limit', min: 0 },
      { name: 'cron_limit', min: 0 },
      { name: 'cron_min_interval_min', min: 1, max: 1440, unit: 'min' },
    ],
  },
  {
    key: 'data',
    fields: [
      { name: 'database_limit', min: 0 },
      { name: 'db_user_limit', min: 0 },
      { name: 'ftp_limit', min: 0 },
      { name: 'backup_quota_mb', min: 0, unit: 'mb' },
    ],
  },
];

const int = (min: number, max?: number) => {
  const base = z
    .number({ error: 'admin:packages.errors.number' })
    .int('admin:packages.errors.number')
    .min(min, `admin:packages.errors.min|${min}`);
  return max === undefined ? base : base.max(max, `admin:packages.errors.max|${max}`);
};

const numeric = Object.fromEntries(
  LIMIT_GROUPS.flatMap((g) => g.fields).map((f) => [f.name, int(f.min, f.max)]),
) as Record<NumKey, ReturnType<typeof int>>;

/** Giới hạn gói (PackageLimits). Giữ dữ liệu sau chấm dứt tối thiểu 30 ngày (D-46). */
export const limitsSchema = z.object({
  ...numeric,
  io_read_bps: z.number().int().min(1).nullable(),
  io_write_bps: z.number().int().min(1).nullable(),
  backup_retention: z.object({ daily: int(0, 60), weekly: int(0, 52), monthly: int(0, 36) }),
  ssh_allowed: z.boolean(),
  php_versions: z.array(z.enum(PHP_VERSIONS)).min(1, 'admin:packages.errors.php'),
  retention_days_after_terminate: z
    .number({ error: 'admin:packages.errors.number' })
    .int('admin:packages.errors.number')
    .min(30, 'admin:packages.errors.retention')
    .max(365, 'admin:packages.errors.max|365'),
});

export const packageSchema = z.object({
  code: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'admin:packages.errors.code'),
  name: z.string().trim().min(1, 'form.required').max(80, 'form.maxLength|80'),
  description: z.string().max(500, 'form.maxLength|500'),
  limits: limitsSchema,
});
export type PackageForm = z.infer<typeof packageSchema>;

/** Giới hạn mặc định cho gói mới. */
export const DEFAULT_LIMITS: Limits = {
  disk_mb: 5120,
  inode_limit: 150000,
  cpu_percent: 100,
  ram_mb: 1024,
  tasks_max: 128,
  php_workers_max: 4,
  io_weight: 100,
  io_read_bps: null,
  io_write_bps: null,
  website_limit: 2,
  alias_domain_limit: 5,
  subdomain_limit: 5,
  database_limit: 2,
  db_user_limit: 2,
  ftp_limit: 2,
  cron_limit: 3,
  cron_min_interval_min: 5,
  backup_quota_mb: 10240,
  backup_retention: { daily: 7, weekly: 4, monthly: 3 },
  ssh_allowed: false,
  php_versions: ['8.3'],
  retention_days_after_terminate: 30,
};

const show = (v: unknown) =>
  Array.isArray(v)
    ? v.join(', ')
    : typeof v === 'object' && v !== null
      ? JSON.stringify(v)
      : String(v);

/** So sánh hai bộ giới hạn: danh sách khóa đã đổi với giá trị cũ → mới (hiển thị dạng chuỗi). */
export function diffLimits(
  a: Limits,
  b: Limits,
): { key: keyof Limits; from: string; to: string }[] {
  return (Object.keys(b) as (keyof Limits)[])
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((k) => ({ key: k, from: show(a[k]), to: show(b[k]) }));
}
