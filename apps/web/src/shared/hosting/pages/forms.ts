import { z } from 'zod';
import { parseCron } from '@/shared/hosting/cron';
import { normalizePath } from '@/shared/hosting/paths';

/** Schema các form Hosting II. Lỗi là khóa i18n (`admin:sites.errors.*`), khớp ràng buộc contract. */

export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const domain = z.string().trim().toLowerCase().regex(DOMAIN_RE, 'admin:sites.errors.domain');
/** Đường dẫn tương đối nằm trong thư mục cha (không `..` thoát ra, không tuyệt đối). */
const relPath = z
  .string()
  .trim()
  .refine((v) => !v.startsWith('/') && normalizePath(v) !== null, 'admin:sites.errors.relPath');
const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'form.required')
    .max(max, `form.maxLength|${max}`)
    .refine((v) => !/[\r\n\0]/.test(v), 'admin:sites.errors.oneLine');
const prefixed = (prefix: string) =>
  z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, 'admin:sites.errors.dbName')
    .refine((v) => prefix === '' || v.startsWith(`${prefix}_`), {
      message: `admin:sites.errors.prefix|${prefix}`,
    });

export const SITE_TYPES = ['php', 'static', 'proxy'] as const;
export const websiteSchema = z
  .object({
    hosting_account_uuid: z.string().min(1, 'admin:sites.errors.account'),
    primary_domain: domain,
    type: z.enum(SITE_TYPES),
    php_version: z.string(),
    document_root: relPath,
    ssl_mode: z.enum(['acme', 'none']),
    proxy_target: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'proxy' && !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(v.proxy_target)) {
      ctx.addIssue({ code: 'custom', path: ['proxy_target'], message: 'admin:sites.errors.proxy' });
    }
    if (v.type === 'php' && !v.php_version) {
      ctx.addIssue({ code: 'custom', path: ['php_version'], message: 'form.required' });
    }
  });
export type WebsiteForm = z.infer<typeof websiteSchema>;

export const domainSchema = z.object({
  name: domain,
  type: z.enum(['alias', 'redirect', 'subdomain']),
});

const size = z
  .string()
  .trim()
  .regex(/^[0-9]{1,5}[kmg]?$/, 'admin:sites.errors.size');
export const phpSchema = z.object({
  version: z.string().min(1, 'form.required'),
  memory_limit: size,
  max_execution_time: z
    .number({ error: 'admin:packages.errors.number' })
    .int('admin:packages.errors.number')
    .min(1, 'admin:packages.errors.min|1')
    .max(600, 'admin:packages.errors.max|600'),
  upload_max_filesize: size,
  pm_max_children: z
    .number({ error: 'admin:packages.errors.number' })
    .int('admin:packages.errors.number')
    .min(1, 'admin:packages.errors.min|1')
    .max(64, 'admin:packages.errors.max|64'),
});
export type PhpForm = z.infer<typeof phpSchema>;

export const nginxSchema = z.object({
  client_max_body_size: size,
  http2: z.boolean(),
  hsts: z.boolean(),
});

export const databaseSchema = (prefix: string) =>
  z.object({
    hosting_account_uuid: z.string().min(1, 'admin:sites.errors.account'),
    engine: z.enum(['mariadb', 'mysql', 'postgresql']),
    name: prefixed(prefix),
    create_user: z.boolean(),
  });
export type DatabaseForm = z.infer<ReturnType<typeof databaseSchema>>;

export const dbUserSchema = (prefix: string) =>
  z.object({
    hosting_account_uuid: z.string().min(1, 'admin:sites.errors.account'),
    engine: z.enum(['mariadb', 'mysql', 'postgresql']),
    username: prefixed(prefix),
    password: z.string().refine((v) => v === '' || v.length >= 16, 'admin:sites.errors.password'),
  });
export type DbUserForm = z.infer<ReturnType<typeof dbUserSchema>>;

export const sftpSchema = (prefix: string) =>
  z.object({
    hosting_account_uuid: z.string().min(1, 'admin:sites.errors.account'),
    username: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{2,31}$/, 'admin:sites.errors.sftpUser')
      .refine((v) => prefix === '' || v.startsWith(`${prefix}_`), {
        message: `admin:sites.errors.prefix|${prefix}`,
      }),
    protocol: z.enum(['sftp', 'ftps']),
    root_path: relPath,
    read_only: z.boolean(),
  });
export type SftpForm = z.infer<ReturnType<typeof sftpSchema>>;

export const SSH_KEY_RE =
  /^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]{16,}( [^\r\n]{0,100})?$/;
export const sshKeySchema = z.object({
  hosting_account_uuid: z.string().min(1, 'admin:sites.errors.account'),
  name: z.string().trim().min(1, 'form.required').max(80, 'form.maxLength|80'),
  public_key: z.string().trim().regex(SSH_KEY_RE, 'admin:sites.errors.sshKey'),
});
export type SshKeyForm = z.infer<typeof sshKeySchema>;

/** Cron: biểu thức 5 trường hợp lệ + không dày hơn `minInterval` phút của gói (kiểm ở UI để báo sớm). */
export const cronSchema = z.object({
  hosting_account_uuid: z.string().min(1, 'admin:sites.errors.account'),
  schedule: z
    .string()
    .trim()
    .refine((v) => parseCron(v).ok, 'admin:sites.errors.cron'),
  command: oneLine(1024),
  working_dir: relPath,
  enabled: z.boolean(),
});
export type CronForm = z.infer<typeof cronSchema>;

export const wpInstallSchema = z.object({
  website_uuid: z.string().min(1, 'admin:sites.errors.website'),
  title: z.string().trim().min(1, 'form.required').max(120, 'form.maxLength|120'),
  admin_username: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,30}$/, 'admin:sites.errors.wpUser')
    .refine((v) => v !== 'admin', 'admin:sites.errors.wpUser'),
  admin_email: z.email('form.email'),
  locale: z.enum(['vi', 'en_US']),
});
export type WpInstallForm = z.infer<typeof wpInstallSchema>;

export const gitRepoSchema = z.object({
  website_uuid: z.string().min(1, 'admin:sites.errors.website'),
  repo_url: z
    .string()
    .trim()
    .regex(/^(ssh:\/\/\S+|git@[^\s:]+:\S+|https:\/\/\S+)$/, 'admin:sites.errors.repoUrl'),
  branch: z
    .string()
    .trim()
    .min(1, 'form.required')
    .regex(/^[A-Za-z0-9._/-]+$/, 'admin:sites.errors.branch'),
  build_command: z
    .string()
    .trim()
    .max(1024, 'form.maxLength|1024')
    .refine((v) => !/[\r\n\0]/.test(v), 'admin:sites.errors.oneLine'),
  shared_paths: z
    .string()
    .refine(
      (v) => splitLines(v).every((p) => !p.startsWith('/') && normalizePath(p) !== null),
      'admin:sites.errors.relPath',
    ),
  auto_deploy: z.boolean(),
  keep_releases: z
    .number({ error: 'admin:packages.errors.number' })
    .int('admin:packages.errors.number')
    .min(1, 'admin:packages.errors.min|1')
    .max(20, 'admin:packages.errors.max|20'),
});
export type GitRepoForm = z.infer<typeof gitRepoSchema>;

/** Tên miền chứng chỉ: domain thường hoặc wildcard `*.domain` (một nhãn). */
export const CERT_DOMAIN_RE =
  /^(\*\.)?(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;
const PEM_KEY =
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (RSA |EC )?PRIVATE KEY-----/;

/** Tải chứng chỉ riêng (POST …/certificates source=upload): kiểm hình thức; API kiểm khóa khớp và hạn. */
export const certUploadSchema = z.object({
  domains: z
    .string()
    .refine((v) => splitDomains(v).length > 0, 'form.required')
    .refine(
      (v) => splitDomains(v).every((d) => CERT_DOMAIN_RE.test(d)),
      'admin:sites.errors.certDomain',
    ),
  certificate_pem: z.string().trim().regex(PEM_CERT, 'admin:sites.errors.certPem'),
  private_key_pem: z.string().trim().regex(PEM_KEY, 'admin:sites.errors.keyPem'),
});
export type CertUploadForm = z.infer<typeof certUploadSchema>;

/** Danh sách domain từ ô nhập (dấu phẩy, khoảng trắng hoặc xuống dòng), chữ thường, không trùng. */
export function splitDomains(v: string): string[] {
  return [
    ...new Set(
      v
        .split(/[\s,]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Body CertificateRequest cho tải lên. */
export function certUploadBody(v: CertUploadForm) {
  return {
    source: 'upload' as const,
    domains: splitDomains(v.domains),
    certificate_pem: v.certificate_pem.trim(),
    private_key_pem: v.private_key_pem.trim(),
  };
}

export function splitLines(v: string): string[] {
  return v
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Ngày còn lại tới hạn chứng chỉ (âm = đã hết hạn). */
export function certDaysLeft(notAfter: string | null, now = Date.now()): number | null {
  return notAfter ? Math.floor((Date.parse(notAfter) - now) / 86_400_000) : null;
}
