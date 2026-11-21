import type { components as A } from '@/api/generated/admin/schema';
import { created, ok, on, problem, type Ctx } from '../router';

type S = A['schemas'];

/**
 * Wizard cài đặt lần đầu trong bản demo (Prompt 4.5). Trạng thái chỉ nằm trong bộ nhớ trình duyệt.
 * Mã thiết lập demo: DEMO-2026-ITSO (bản thật: `sudo itso setup-code`, mỗi mã dùng một lần).
 */
export const DEMO_SETUP_CODE = 'DEMO-2026-ITSO';

interface WizardState {
  installed: boolean;
  codeUsed: boolean;
  verified: boolean;
  locale: 'vi' | 'en';
  timezone: string;
  preferencesSaved: boolean;
  admin: boolean;
  access: S['SetupAccess'] | null;
  quotaSeen: boolean;
}

const fresh = (): WizardState => ({
  installed: false,
  codeUsed: false,
  verified: false,
  locale: 'vi',
  timezone: 'Asia/Ho_Chi_Minh',
  preferencesSaved: false,
  admin: false,
  access: null,
  quotaSeen: false,
});

let state = fresh();

/** Cho test: đặt lại trạng thái wizard demo. */
export function resetDemoSetup() {
  state = fresh();
}

const P = (p: string) => `/api/v1/admin${p}` as Parameters<typeof on>[1];
const gone = () =>
  problem(
    410,
    'setup_completed',
    'Wizard đã khóa',
    'Panel đã cài đặt xong; wizard không dùng lại được.',
  );
const notVerified = () =>
  problem(
    403,
    'setup_not_verified',
    'Chưa xác minh mã thiết lập',
    'Nhập mã thiết lập ở bước 0 trước.',
  );
const invalid = (detail: string) =>
  problem(422, 'validation_failed', 'Dữ liệu không hợp lệ', detail);
const body = <T>(ctx: Ctx) => (ctx.body ?? {}) as Partial<T>;

function status(): S['SetupStatus'] {
  if (state.installed) {
    return {
      installed: true,
      code_verified: false,
      admin_created: true,
      admin_mfa_enabled: true,
      locale: state.locale,
      timezone: state.timezone,
      access: null,
      steps_done: [],
    };
  }
  const steps: S['SetupStatus']['steps_done'] = [];
  if (state.verified) steps.push('code');
  if (state.verified && state.preferencesSaved) steps.push('language');
  if (state.admin) steps.push('admin');
  if (state.access) steps.push('access');
  if (state.quotaSeen) steps.push('quota');
  return {
    installed: false,
    code_verified: state.verified,
    admin_created: state.admin,
    admin_mfa_enabled: state.admin,
    locale: state.locale,
    timezone: state.timezone,
    access: state.access,
    steps_done: steps,
  };
}

const CIDR = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(\/(3[0-2]|[12]?\d))?$/;

export function registerSetup() {
  on('get', P('/setup/status'), () => ok(status()));

  on('post', P('/setup/code:verify'), (ctx) => {
    if (state.installed) return gone();
    const code = String(body<S['SetupCodeVerify']>(ctx).code ?? '').toUpperCase();
    if (code !== DEMO_SETUP_CODE) return invalid('Mã thiết lập không đúng.');
    if (state.codeUsed)
      return problem(409, 'setup_code_used', 'Mã đã được dùng', 'Mỗi mã chỉ dùng một lần.');
    state.codeUsed = true;
    state.verified = true;
    return ok(status());
  });

  on('put', P('/setup/preferences'), (ctx) => {
    if (state.installed) return gone();
    if (!state.verified) return notVerified();
    const b = body<S['SetupPreferences']>(ctx);
    if (b.locale !== 'vi' && b.locale !== 'en') return invalid('Ngôn ngữ không hợp lệ.');
    if (!b.timezone) return invalid('Chọn múi giờ.');
    state.locale = b.locale;
    state.timezone = b.timezone;
    state.preferencesSaved = true;
    return ok(status());
  });

  on('post', P('/setup/admin'), (ctx) => {
    if (state.installed) return gone();
    if (!state.verified) return notVerified();
    if (state.admin) return problem(409, 'conflict', 'Xung đột', 'Wizard đã tạo SUPER_ADMIN.');
    const b = body<S['SetupAdmin']>(ctx);
    if (!b.email || !b.name || (b.password ?? '').length < 12)
      return invalid('Tên, email và mật khẩu từ 12 ký tự là bắt buộc.');
    state.admin = true;
    const user = ctx.db.data.users.find((u) => u.uuid === ctx.actor.uuid);
    return created({
      user: { ...user, name: b.name, email: b.email },
      permissions: ['*'],
      scopes: [],
      mfa_verified_at: null,
      impersonating: null,
    });
  });

  on('put', P('/setup/access'), (ctx) => {
    if (state.installed) return gone();
    if (!state.admin) return problem(403, 'forbidden', 'Không có quyền');
    const b = body<S['SetupAccess']>(ctx);
    const port = Number(b.panel_port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      return invalid('Cổng phải từ 1024 đến 65535.');
    if ((b.allowlist ?? []).some((x) => !CIDR.test(x)))
      return invalid('Địa chỉ IP/CIDR không hợp lệ.');
    state.access = {
      panel_domain: b.panel_domain ?? null,
      panel_port: port,
      entrance_path: b.entrance_path ?? null,
      allowlist: b.allowlist ?? [],
    };
    return ok(status());
  });

  on('get', P('/setup/quota'), (ctx) => {
    if (state.installed) return gone();
    state.quotaSeen = true;
    const srv = ctx.db.data.servers[0];
    return ok({
      mode: srv?.platform?.quota_mode ?? 'unknown',
      server: srv ? { uuid: srv.uuid, name: srv.name } : null,
      facts_at: srv?.platform?.facts_at ?? null,
    });
  });

  on('post', P('/setup:complete'), () => {
    if (state.installed) return gone();
    if (!state.access)
      return problem(409, 'invalid_state_transition', 'Chưa xong bước truy cập panel');
    state.installed = true;
    return ok(status());
  });

  on('get', P('/system/updates'), () =>
    ok({
      current_version: '0.4.0-demo',
      commit: 'phase-4',
      channel: 'stable',
      latest_version: null,
      update_available: false,
      checked_at: null,
      update_command: 'sudo itso update --release-dir <thư mục release đã tải>',
      releases: [
        { version: '0.4.0-demo', active: true },
        { version: '0.3.0', active: false },
      ],
    } satisfies S['SystemUpdates']),
  );
}
