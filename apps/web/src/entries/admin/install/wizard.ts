/**
 * Logic wizard cài đặt lần đầu (10 bước, module 30). Kiểm tra hợp lệ phía trình duyệt trước khi gọi API
 * /admin/setup/* (Phase 4: bước code, language, admin, access, quota, summary; Phase 5: stack, không bắt buộc).
 * Bước security, backup, smtp chưa có ở bản này (LATER) nên không chặn. Lỗi là khóa i18n (admin:install.errors.*).
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

/** Bước chưa hiện thực ở bản này: hiện thông báo, không gọi API, không chặn đi tiếp. */
export const LATER: readonly Step[] = ['security', 'backup', 'smtp'];

export interface InstallState {
  setupCode: string;
  locale: 'vi' | 'en';
  timezone: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  mfaCode: string;
  /** SA đã được tạo (POST /admin/setup/admin) → bước admin chuyển sang nhập mã TOTP. */
  adminCreated: boolean;
  totpSecret: string;
  totpUri: string;
  panelDomain: string;
  panelPort: number;
  entrancePath: string;
  allowlist: string;
}

export const INITIAL: InstallState = {
  setupCode: '',
  locale: 'vi',
  timezone: 'Asia/Ho_Chi_Minh',
  adminName: '',
  adminEmail: '',
  adminPassword: '',
  mfaCode: '',
  adminCreated: false,
  totpSecret: '',
  totpUri: '',
  panelDomain: '',
  panelPort: 8443,
  entrancePath: '',
  allowlist: '',
};

const FQDN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IPV4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(\/(3[0-2]|[12]?\d))?$/;
const IPV6 = /^[0-9a-f:]+:[0-9a-f:]*(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/i;
const ENTRANCE = /^\/[a-z0-9][a-z0-9-]{3,31}$/;

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
      if (s.adminCreated) {
        if (!/^[0-9]{6}$/.test(s.mfaCode)) e.mfaCode = 'mfa';
        break;
      }
      if (s.adminName.trim().length < 2) e.adminName = 'required';
      if (!EMAIL.test(s.adminEmail)) e.adminEmail = 'email';
      if (s.adminPassword.length < 12) e.adminPassword = 'password';
      break;
    case 'access':
      if (s.panelDomain.trim() !== '' && !FQDN.test(s.panelDomain.trim().toLowerCase()))
        e.panelDomain = 'domain';
      if (!Number.isInteger(s.panelPort) || s.panelPort < 1024 || s.panelPort > 65535)
        e.panelPort = 'port';
      if (s.entrancePath.trim() !== '' && !ENTRANCE.test(s.entrancePath.trim()))
        e.entrancePath = 'entrance';
      if (allowlistLines(s.allowlist).some((l) => !IPV4.test(l) && !IPV6.test(l)))
        e.allowlist = 'ip';
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

/** Cảnh báo không chặn (hiện ở tổng kết). `quotaMode` lấy từ GET /admin/setup/quota. */
export function warnings(s: InstallState, quotaMode?: 'kernel' | 'soft' | 'unknown'): string[] {
  const w: string[] = [];
  if (allowlistLines(s.allowlist).length === 0) w.push('noAllowlist');
  if (quotaMode === 'soft') w.push('quotaSoft');
  if (quotaMode === 'unknown') w.push('quotaUnknown');
  return w;
}

/** Body PUT /admin/setup/access từ state. */
export function accessBody(s: InstallState) {
  return {
    panel_domain: s.panelDomain.trim() === '' ? null : s.panelDomain.trim().toLowerCase(),
    panel_port: s.panelPort,
    entrance_path: s.entrancePath.trim() === '' ? null : s.entrancePath.trim(),
    allowlist: allowlistLines(s.allowlist),
  };
}

/** Bước tiếp tục khi mở lại trang, theo steps_done của GET /admin/setup/status. */
export function resumeStep(done: readonly string[]): Step {
  if (!done.includes('code')) return 'code';
  if (!done.includes('language')) return 'language';
  if (!done.includes('admin')) return 'admin';
  if (!done.includes('access')) return 'access';
  if (!done.includes('quota')) return 'stack';
  return 'summary';
}
