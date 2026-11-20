import { z } from 'zod';
import { parseCron } from '@/shared/hosting/cron';

const num = (min: number, max: number) =>
  z
    .number({ error: 'admin:packages.errors.number' })
    .int('admin:packages.errors.number')
    .min(min, `admin:packages.errors.min|${min}`)
    .max(max, `admin:packages.errors.max|${max}`);

export const policySchema = z
  .object({
    name: z.string().trim().min(1, 'form.required').max(80, 'form.maxLength|80'),
    scope_type: z.enum(['all_accounts', 'hosting_account', 'server', 'panel']),
    scope_uuid: z.string(),
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
    if ((v.scope_type === 'server' || v.scope_type === 'hosting_account') && !v.scope_uuid)
      ctx.addIssue({ code: 'custom', path: ['scope_uuid'], message: 'form.required' });
    if (v.daily + v.weekly + v.monthly === 0)
      ctx.addIssue({ code: 'custom', path: ['daily'], message: 'admin:bk.errors.keep' });
  });
export type PolicyForm = z.infer<typeof policySchema>;

/** Trường cấu hình (config) và bí mật (credentials) theo loại đích. */
export const DEST_FIELDS = {
  local: { config: ['path'], secret: [] },
  sftp: { config: ['host', 'path'], secret: ['password'] },
  s3: { config: ['endpoint', 'bucket', 'region'], secret: ['access_key', 'secret_key'] },
  rest: { config: ['url'], secret: ['password'] },
} as const;
export type DestType = keyof typeof DEST_FIELDS;

export const destSchema = z
  .object({
    name: z.string().trim().min(1, 'form.required').max(80, 'form.maxLength|80'),
    type: z.enum(['local', 'sftp', 's3', 'rest']),
    path: z.string().trim(),
    host: z.string().trim(),
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
      if (k !== 'region' && !v[k])
        ctx.addIssue({ code: 'custom', path: [k], message: 'form.required' });
    }
    if ((v.type === 'local' || v.type === 'sftp') && v.path && !v.path.startsWith('/'))
      ctx.addIssue({ code: 'custom', path: ['path'], message: 'admin:bk.errors.absPath' });
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

export const backupNowSchema = z
  .object({
    hosting_account_uuid: z.string().min(1, 'admin:sites.pickAccount'),
    files: z.boolean(),
    databases: z.boolean(),
    config: z.boolean(),
    note: z.string().max(200, 'form.maxLength|200'),
  })
  .refine((v) => v.files || v.databases || v.config, {
    path: ['files'],
    message: 'admin:bk.errors.contents',
  });
export type BackupNowForm = z.infer<typeof backupNowSchema>;

/** Mục khôi phục từ lựa chọn trên cây snapshot: thư mục/file → files:<path>, dump → database:<tên>, config. */
export function restoreItem(path: string): string {
  const db = /^databases\/([a-z][a-z0-9_]{0,63})\.sql\.zst$/.exec(path);
  if (db) return `database:${db[1]}`;
  if (path === 'config' || path.startsWith('config/')) return 'config';
  return `files:${path}`;
}

/** Bỏ mục con khi đã chọn thư mục cha; gộp config; giữ thứ tự. */
export function normalizeItems(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort();
  const keep = sorted.filter((p) => !sorted.some((q) => q !== p && p.startsWith(`${q}/`)));
  return [...new Set(keep.map(restoreItem))];
}
