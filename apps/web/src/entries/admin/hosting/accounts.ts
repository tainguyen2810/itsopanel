import { z } from 'zod';
import type { Data, Row } from '../api';

export type Account = Data<'/api/v1/admin/hosting-accounts/{id}'>;
export type Migration = Row<'/api/v1/admin/account-migrations'>;
export type Purge = Row<'/api/v1/admin/purge-records'>;

/** Tên hệ thống không dùng làm username (khớp contracts Username và kiểm tra của API). */
export const RESERVED_USERNAMES = [
  'root',
  'admin',
  'www',
  'nginx',
  'mysql',
  'postgres',
  'itso',
  'backup',
] as const;

export const usernameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]{2,15}$/, 'admin:accounts.errors.username')
  .refine((v) => !(RESERVED_USERNAMES as readonly string[]).includes(v), {
    message: 'admin:accounts.errors.reserved',
  });

const domain = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Các bước wizard tạo account và trường mà mỗi bước kiểm tra trước khi sang bước sau. */
export const ACCOUNT_STEPS = [
  { key: 'owner', fields: ['owner_user_uuid'] },
  { key: 'package', fields: ['package_uuid'] },
  { key: 'server', fields: ['server_uuid'] },
  { key: 'identity', fields: ['username', 'primary_domain'] },
] as const;

export const accountSchema = z.object({
  owner_user_uuid: z.string().min(1, 'admin:accounts.errors.owner'),
  package_uuid: z.string().min(1, 'admin:accounts.errors.package'),
  server_uuid: z.string().min(1, 'admin:accounts.errors.server'),
  username: usernameSchema,
  primary_domain: z
    .string()
    .trim()
    .toLowerCase()
    .refine((v) => v === '' || domain.test(v), { message: 'admin:accounts.errors.domain' }),
});
export type AccountForm = z.infer<typeof accountSchema>;

/** Gợi ý username từ tên chủ sở hữu: bỏ dấu, chỉ giữ chữ/số, tối đa 16 ký tự, bắt đầu bằng chữ. */
export function suggestUsername(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/^(cong ty|phong|truong|nha thuoc|du an|studio)\s+/, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, 16);
  return base.length >= 3 ? base : '';
}

/** Số ngày (làm tròn lên, không âm) còn lại tới mốc `until` tính từ `now`. */
export function daysLeft(until: string | null, now = Date.now()): number | null {
  if (!until) return null;
  return Math.max(0, Math.ceil((Date.parse(until) - now) / 86_400_000));
}

/** Bước hiện tại của wizard chuyển server theo trạng thái lần chuyển. */
export const MIGRATION_STEPS = ['preflight', 'sync', 'verify', 'cutover', 'done'] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];

export function migrationStep(m: Pick<Migration, 'state'> | null | undefined): MigrationStep {
  switch (m?.state) {
    case undefined:
      return 'preflight';
    // Bản ghi chỉ có sau khi bắt đầu chuyển: job preflight + sync đang chạy.
    case 'preflight':
    case 'syncing':
      return 'sync';
    case 'verifying':
      return 'verify';
    case 'cutover':
      return 'cutover';
    default:
      return 'done';
  }
}

/** Trạng thái purge theo D-46: chờ backup → chờ SA thứ hai xác nhận → đã xác nhận → đã xóa. */
export function purgeStage(
  p: Pick<Purge, 'backup_verified_at' | 'confirmed_by' | 'completed_at'> | undefined,
): 'none' | 'backup' | 'confirm' | 'scheduled' | 'done' {
  if (!p) return 'none';
  if (p.completed_at) return 'done';
  if (!p.backup_verified_at) return 'backup';
  return p.confirmed_by ? 'scheduled' : 'confirm';
}
