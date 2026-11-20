import { z } from 'zod';

export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'] as const;
export type DnsType = (typeof DNS_TYPES)[number];
/** Loại record đi qua proxy Cloudflare được. */
export const PROXIABLE: readonly DnsType[] = ['A', 'AAAA', 'CNAME'];
export const NEEDS_PRIORITY: readonly DnsType[] = ['MX', 'SRV'];

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST =
  /^(?=.{1,253}\.?$)([a-z0-9_]([a-z0-9-_]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.?$/i;
/** Tên record: `@` (gốc zone), `*` hoặc nhãn tương đối (vd. `www`, `_dmarc`, `*.dev`). */
const NAME =
  /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9-_]{0,61}[a-z0-9])?(\.[a-z0-9_]([a-z0-9-_]{0,61}[a-z0-9])?)*)$/i;

export function isIPv6(v: string): boolean {
  if (!/^[0-9a-f:.]+$/i.test(v) || v.split('::').length > 2) return false;
  const [head = '', tail] = v.split('::');
  const part = (x: string) => (x === '' ? [] : x.split(':'));
  const groups = [...part(head), ...(tail === undefined ? [] : part(tail))];
  // Nhóm rỗng chỉ được xuất hiện qua một lần `::` (chặn `:::`, `:1`, `1:`).
  if (groups.some((g) => g === '')) return false;
  const v4 = groups.at(-1)?.includes('.') ? groups.pop() : undefined;
  if (v4 !== undefined && !IPV4.test(v4)) return false;
  const max = v4 === undefined ? 8 : 6;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  return tail === undefined ? groups.length === max : groups.length < max;
}

/** Kiểm nội dung theo loại record. Trả khóa lỗi i18n hoặc null. */
export function contentError(type: DnsType, content: string): string | null {
  const c = content.trim();
  switch (type) {
    case 'A':
      return IPV4.test(c) ? null : 'ipv4';
    case 'AAAA':
      return isIPv6(c) ? null : 'ipv6';
    case 'CNAME':
    case 'NS':
    case 'MX':
      return HOST.test(c) && !IPV4.test(c) ? null : 'hostname';
    case 'TXT':
      return c.length > 0 && c.length <= 2048 ? null : 'txt';
    case 'SRV': {
      const m = /^(\d{1,5}) (\d{1,5}) (\S+)$/.exec(c);
      return m && Number(m[1]) <= 65535 && Number(m[2]) <= 65535 && HOST.test(m[3] as string)
        ? null
        : 'srv';
    }
    case 'CAA':
      return /^(0|128) (issue|issuewild|iodef) "[^"]{1,255}"$/.test(c) ? null : 'caa';
  }
}

export const dnsRecordSchema = z
  .object({
    type: z.enum(DNS_TYPES),
    name: z.string().trim().min(1, 'form.required').regex(NAME, 'admin:dns.errors.name'),
    content: z.string().trim().min(1, 'form.required'),
    ttl: z
      .number({ error: 'admin:dns.errors.ttl' })
      .int('admin:dns.errors.ttl')
      .refine((v) => v >= 60 && v <= 86400, 'admin:dns.errors.ttl'),
    priority: z.number().int().min(0).max(65535).optional(),
    proxied: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const e = contentError(v.type, v.content);
    if (e) ctx.addIssue({ code: 'custom', path: ['content'], message: `admin:dns.errors.${e}` });
    if (NEEDS_PRIORITY.includes(v.type) && (v.priority === undefined || Number.isNaN(v.priority))) {
      ctx.addIssue({ code: 'custom', path: ['priority'], message: 'admin:dns.errors.priority' });
    }
    if (v.proxied && !PROXIABLE.includes(v.type)) {
      ctx.addIssue({ code: 'custom', path: ['proxied'], message: 'admin:dns.errors.proxied' });
    }
    if (v.type === 'CNAME' && v.name === '@') {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'admin:dns.errors.cnameApex' });
    }
  });
export type DnsRecordForm = z.infer<typeof dnsRecordSchema>;

/** Gợi ý nội dung mẫu cho từng loại (placeholder). */
export const DNS_PLACEHOLDER: Record<DnsType, string> = {
  A: '203.0.113.10',
  AAAA: '2001:db8::10',
  CNAME: 'anphat.vn',
  MX: 'mail.anphat.vn',
  TXT: 'v=spf1 mx -all',
  SRV: '10 5060 sip.anphat.vn',
  CAA: '0 issue "letsencrypt.org"',
  NS: 'ns1.itso.vn',
};
