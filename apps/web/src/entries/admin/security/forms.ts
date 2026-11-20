import { z } from 'zod';

/** SSH của máy chủ: chặn cấu hình tự khóa mình ra ngoài (không còn nhóm nào được SSH). */
export const sshSchema = z.object({
  port: z
    .number({ error: 'admin:packages.errors.number' })
    .int()
    .min(1, 'admin:packages.errors.min|1')
    .max(65535, 'admin:packages.errors.max|65535'),
  password_authentication: z.boolean(),
  permit_root_login: z.enum(['no', 'prohibit-password']),
  allow_groups: z
    .string()
    .trim()
    .min(1, 'admin:sec.errors.groups')
    .refine(
      (s) => splitList(s).every((g) => /^[a-z][a-z0-9-]{0,31}$/.test(g)),
      'admin:sec.errors.group',
    ),
  max_auth_tries: z
    .number({ error: 'admin:packages.errors.number' })
    .int()
    .min(1, 'admin:packages.errors.min|1')
    .max(10, 'admin:packages.errors.max|10'),
});
export type SshForm = z.infer<typeof sshSchema>;

export const jailSchema = z.object({
  enabled: z.boolean(),
  bantime_sec: z
    .number({ error: 'admin:packages.errors.number' })
    .int()
    .min(60, 'admin:packages.errors.min|60'),
  findtime_sec: z
    .number({ error: 'admin:packages.errors.number' })
    .int()
    .min(60, 'admin:packages.errors.min|60'),
  maxretry: z
    .number({ error: 'admin:packages.errors.number' })
    .int()
    .min(1, 'admin:packages.errors.min|1')
    .max(100, 'admin:packages.errors.max|100'),
});
export type JailForm = z.infer<typeof jailSchema>;

/** Danh sách cách nhau bởi dấu phẩy hoặc khoảng trắng → mảng không rỗng, không trùng. */
export function splitList(s: string): string[] {
  return [
    ...new Set(
      s
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

const IPV4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]+$/i;

/** Kiểm IP hoặc CIDR (IPv4 /0–32, IPv6 /0–128). */
export function isCidr(s: string): boolean {
  const [ip = '', bits, extra] = s.trim().split('/');
  if (extra !== undefined) return false;
  if (IPV4.test(ip)) return bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32);
  if (IPV6.test(ip) && ip.includes(':'))
    return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128);
  return false;
}

const v4 = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + Number(p), 0);

/** IPv4 có thuộc dải CIDR không (IPv6 so khớp nguyên văn). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [net = '', bitsRaw] = cidr.split('/');
  if (!IPV4.test(ip) || !IPV4.test(net)) return ip === net;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (bits === 0) return true;
  const mask = 2 ** 32 - 2 ** (32 - bits);
  return (v4(ip) & mask) >>> 0 === (v4(net) & mask) >>> 0;
}

export const allowlistSchema = z.object({
  entries: z
    .array(
      z.object({
        cidr: z.string().trim().refine(isCidr, 'admin:sec.errors.cidr'),
        note: z.string().trim().max(120, 'form.maxLength|120'),
      }),
    )
    .min(1, 'admin:sec.errors.allowEmpty')
    .superRefine((rows, ctx) => {
      const seen = new Set<string>();
      rows.forEach((r, i) => {
        if (seen.has(r.cidr.trim()))
          ctx.addIssue({ code: 'custom', path: [i, 'cidr'], message: 'admin:sec.errors.dup' });
        seen.add(r.cidr.trim());
      });
    }),
});
export type AllowlistForm = z.infer<typeof allowlistSchema>;
