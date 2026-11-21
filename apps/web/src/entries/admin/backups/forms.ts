import { z } from 'zod';
import { parseCron } from '@/shared/hosting/cron';

const num = (min: number, max: number) =>
  z
    .number({ error: 'admin:packages.errors.number' })
    .int('admin:packages.errors.number')
    .min(min, `admin:packages.errors.min|${min}`)
    .max(max, `admin:packages.errors.max|${max}`);

/** Phạm vi cần chọn đối tượng cụ thể. */
export const SCOPE_TARGET: readonly string[] = ['hosting_account', 'website', 'database', 'server'];
/** Phạm vi chọn được nội dung (file/DB/cấu hình); server và panel luôn là cấu hình. */
export const CONTENT_SCOPES: readonly string[] = ['all_accounts', 'hosting_account'];

/** Mẫu loại trừ: mỗi dòng một mẫu, bỏ dòng trống. */
export const excludeLines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

export const policySchema = z
  .object({
    name: z.string().trim().min(1, 'form.required').max(80, 'form.maxLength|80'),
    scope_type: z.enum([
      'all_accounts',
      'hosting_account',
      'website',
      'database',
      'server',
      'panel',
    ]),
    scope_uuid: z.string(),
    contents: z.array(z.enum(['files', 'databases', 'config'])),
    excludes: z.string().max(5000, 'form.maxLength|5000'),
    schedule: z
      .string()
      .trim()
      .refine((s) => parseCron(s).ok, 'admin:sites.errors.cron'),
    destination_uuids: z.array(z.string()).min(1, 'admin:bk.errors.dest'),
    daily: num(0, 999),
    weekly: num(0, 999),
    monthly: num(0, 999),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (SCOPE_TARGET.includes(v.scope_type) && !v.scope_uuid)
      ctx.addIssue({ code: 'custom', path: ['scope_uuid'], message: 'form.required' });
    if (CONTENT_SCOPES.includes(v.scope_type) && v.contents.length === 0)
      ctx.addIssue({ code: 'custom', path: ['contents'], message: 'admin:bk.errors.contents' });
    const bad = excludeLines(v.excludes).find(
      (x) => x.length > 200 || x.startsWith('/') || x.split('/').includes('..'),
    );
    if (bad)
      ctx.addIssue({ code: 'custom', path: ['excludes'], message: 'admin:bk.errors.exclude' });
    if (excludeLines(v.excludes).length > 50)
      ctx.addIssue({ code: 'custom', path: ['excludes'], message: 'admin:bk.errors.excludeMax' });
    if (v.daily + v.weekly + v.monthly === 0)
      ctx.addIssue({ code: 'custom', path: ['daily'], message: 'admin:bk.errors.keep' });
  });
export type PolicyForm = z.infer<typeof policySchema>;

/** Trường cấu hình (config) và bí mật (credentials) theo loại đích. */
export const DEST_FIELDS = {
  local: { config: ['path'], secret: [] },
  // SFTP: agent sinh khóa SSH riêng cho đích (không nhập mật khẩu), host key ghim ở lần kiểm tra đầu.
  sftp: { config: ['host', 'port', 'user', 'path'], secret: [] },
  s3: { config: ['endpoint', 'bucket', 'region'], secret: ['access_key', 'secret_key'] },
  // rest-server: user chỉ có quyền append-only.
  rest: { config: ['url', 'user'], secret: ['password'] },
} as const;
export type DestType = keyof typeof DEST_FIELDS;

export const destSchema = z
  .object({
    name: z.string().trim().min(1, 'form.required').max(80, 'form.maxLength|80'),
    type: z.enum(['local', 'sftp', 's3', 'rest']),
    path: z.string().trim(),
    host: z.string().trim(),
    port: z.string().trim(),
    user: z.string().trim(),
    endpoint: z.string().trim(),
    bucket: z.string().trim(),
    region: z.string().trim(),
    url: z.string().trim(),
    password: z.string(),
    access_key: z.string(),
    secret_key: z.string(),
    append_only: z.boolean(),
    immutable: z.boolean(),
    immutable_days: z.number().int().optional(),
  })
  .superRefine((v, ctx) => {
    for (const k of DEST_FIELDS[v.type].config) {
      if (k !== 'region' && k !== 'port' && !v[k])
        ctx.addIssue({ code: 'custom', path: [k], message: 'form.required' });
    }
    if ((v.type === 'local' || v.type === 'sftp') && v.path && !v.path.startsWith('/'))
      ctx.addIssue({ code: 'custom', path: ['path'], message: 'admin:bk.errors.absPath' });
    if (
      v.type === 'sftp' &&
      v.port &&
      !(/^\d{1,5}$/.test(v.port) && +v.port >= 1 && +v.port <= 65535)
    )
      ctx.addIssue({ code: 'custom', path: ['port'], message: 'admin:bk.errors.port' });
    if (v.type === 'sftp' && v.host && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(v.host))
      ctx.addIssue({ code: 'custom', path: ['host'], message: 'admin:bk.errors.host' });
    for (const k of ['endpoint', 'url'] as const) {
      if (DEST_FIELDS[v.type].config.includes(k as never) && v[k] && !/^https:\/\/\S+$/.test(v[k]))
        ctx.addIssue({ code: 'custom', path: [k], message: 'admin:bk.errors.https' });
    }
    if (v.immutable && v.type === 's3' && !(v.immutable_days && v.immutable_days >= 1))
      ctx.addIssue({
        code: 'custom',
        path: ['immutable_days'],
        message: 'admin:packages.errors.min|1',
      });
  });
export type DestForm = z.infer<typeof destSchema>;

/** Form → body BackupDestinationInput (chỉ gửi trường của loại đã chọn). */
export function destBody(v: DestForm) {
  const f = DEST_FIELDS[v.type];
  const config: Record<string, string> = {};
  for (const k of f.config) if (v[k]) config[k] = v[k];
  const credentials: Record<string, string> = {};
  for (const k of f.secret) if (v[k]) credentials[k] = v[k];
  return {
    name: v.name,
    type: v.type,
    config,
    append_only: v.append_only,
    immutable_days: v.type === 's3' && v.immutable ? (v.immutable_days ?? null) : null,
    ...(Object.keys(credentials).length ? { credentials } : {}),
  };
}

export { backupNowSchema, type BackupNowForm } from '@/shared/hosting/backup';

export { normalizeItems, restoreItem } from '@/shared/hosting/backup';
