/**
 * Logic wizard cài đặt lần đầu (10 bước, module 30). Chỉ giao diện ở Phase 2: không gọi API,
 * kiểm tra hợp lệ từng bước để không đi tiếp khi thiếu dữ liệu. Lỗi là khóa i18n (admin:install.errors.*).
 */
export const STEPS = [
  'code',
  'language',
  'admin',
  'access',
  'stack',
  'security',
  'quota',
  'backup',
  'smtp',
  'summary',
] as const;
export type Step = (typeof STEPS)[number];

export interface InstallState {
  setupCode: string;
  locale: 'vi' | 'en';
  timezone: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  mfaCode: string;
  panelDomain: string;
  panelPort: number;
  allowlist: string;
  php: string[];
  database: 'postgresql' | 'mysql' | 'both';
  redis: boolean;
  firewall: boolean;
  fail2ban: boolean;
  sshPort: number;
  sshPasswordAuth: boolean;
  quota: boolean;
  backupType: 'local' | 's3' | 'sftp';
  backupTarget: string;
  retentionDays: number;
  smtpSkip: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpFrom: string;
}

export const INITIAL: InstallState = {
  setupCode: '',
  locale: 'vi',
  timezone: 'Asia/Ho_Chi_Minh',
  adminName: '',
  adminEmail: '',
  adminPassword: '',
  mfaCode: '',
  panelDomain: '',
  panelPort: 8443,
  allowlist: '',
  php: ['8.3'],
  database: 'postgresql',
  redis: true,
  firewall: true,
  fail2ban: true,
  sshPort: 22,
  sshPasswordAuth: false,
  quota: true,
  backupType: 'local',
  backupTarget: '/var/backups/itso',
  retentionDays: 14,
  smtpSkip: false,
  smtpHost: '',
  smtpPort: 587,
  smtpFrom: '',
};

const FQDN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IPV4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(\/(3[0-2]|[12]?\d))?$/;
const port = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;

/** Các dòng allowlist (bỏ dòng trống, khoảng trắng). */
export function allowlistLines(s: string): string[] {
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Lỗi của một bước: { trường: khóa lỗi }. Rỗng = hợp lệ. */
export function validate(step: Step, s: InstallState): Partial<Record<keyof InstallState, string>> {
  const e: Partial<Record<keyof InstallState, string>> = {};
  switch (step) {
    case 'code':
      if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(s.setupCode.trim().toUpperCase()))
        e.setupCode = 'setupCode';
      break;
    case 'admin':
      if (s.adminName.trim().length < 2) e.adminName = 'required';
      if (!EMAIL.test(s.adminEmail)) e.adminEmail = 'email';
      if (s.adminPassword.length < 12) e.adminPassword = 'password';
      if (!/^[0-9]{6}$/.test(s.mfaCode)) e.mfaCode = 'mfa';
      break;
    case 'access':
      if (!FQDN.test(s.panelDomain.trim().toLowerCase())) e.panelDomain = 'domain';
      if (!port(s.panelPort) || [22, 80].includes(s.panelPort)) e.panelPort = 'port';
      if (allowlistLines(s.allowlist).some((l) => !IPV4.test(l))) e.allowlist = 'ip';
      break;
    case 'stack':
      if (s.php.length === 0) e.php = 'php';
      break;
    case 'security':
      if (!port(s.sshPort)) e.sshPort = 'port';
      break;
    case 'backup':
      if (s.backupType !== 'local' && s.backupTarget.trim() === '') e.backupTarget = 'required';
      if (s.backupType === 'local' && !s.backupTarget.startsWith('/')) e.backupTarget = 'path';
      if (!Number.isInteger(s.retentionDays) || s.retentionDays < 1 || s.retentionDays > 3650)
        e.retentionDays = 'retention';
      break;
    case 'smtp':
      if (s.smtpSkip) break;
      if (!FQDN.test(s.smtpHost.trim().toLowerCase())) e.smtpHost = 'domain';
      if (!port(s.smtpPort)) e.smtpPort = 'port';
      if (!EMAIL.test(s.smtpFrom)) e.smtpFrom = 'email';
      break;
    default:
      break;
  }
  return e;
}

export function canProceed(step: Step, s: InstallState): boolean {
  return Object.keys(validate(step, s)).length === 0;
}

/** Bước đầu tiên chưa hợp lệ (để chặn nhảy cóc tới tổng kết). */
export function firstInvalid(s: InstallState): Step | null {
  return STEPS.find((st) => !canProceed(st, s)) ?? null;
}

/** Cảnh báo không chặn (hiện ở tổng kết). */
export function warnings(s: InstallState): string[] {
  const w: string[] = [];
  if (allowlistLines(s.allowlist).length === 0) w.push('noAllowlist');
  if (s.sshPasswordAuth) w.push('sshPassword');
  if (!s.firewall) w.push('noFirewall');
  if (s.backupType === 'local') w.push('localBackup');
  if (s.smtpSkip) w.push('noSmtp');
  return w;
}
