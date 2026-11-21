import type { components as A } from '@/api/generated/admin/schema';
import { created, ok, on, problem, type Ctx } from '../router';
import { startJob } from './writes';

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
  /** Bước 4: thành phần đã cài, job cài đang chạy (Prompt 5.5). */
  stack: Record<StackKey, string | null>;
  stackJob: string | null;
}

type StackKey = 'nginx' | 'php8.3' | 'lego';
const STACK: { key: StackKey; name: string; version: string; op: string }[] = [
  { key: 'nginx', name: 'Nginx', version: '1.24.0', op: 'software.install' },
  { key: 'php8.3', name: 'PHP 8.3 (FPM)', version: '8.3.6', op: 'php.version.install' },
  { key: 'lego', name: 'lego (ACME)', version: '4.9.1', op: 'software.install' },
];

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
  stack: { nginx: '1.24.0', 'php8.3': null, lego: null },
  stackJob: null,
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
      restore_mode: false,
    };
  }
  const steps: S['SetupStatus']['steps_done'] = [];
  if (state.verified) steps.push('code');
  if (state.verified && state.preferencesSaved) steps.push('language');
  if (state.admin) steps.push('admin');
  if (state.access) steps.push('access');
  if (state.access && STACK.every((c) => state.stack[c.key])) steps.push('stack');
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
    restore_mode: false,
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

  const stackView = (ctx: Ctx): S['SetupStack'] => {
    const job = state.stackJob
      ? ctx.db.data.jobs.find((j) => j.uuid === state.stackJob)
      : undefined;
    const busy = job !== undefined && ['queued', 'running'].includes(job.state);
    const srv = ctx.db.data.servers[0];
    return {
      server: srv ? { uuid: srv.uuid, name: srv.name } : null,
      ready: STACK.every((c) => state.stack[c.key]),
      job_uuid: state.stackJob,
      components: STACK.map((c) => ({
        key: c.key,
        name: c.name,
        installed_version: state.stack[c.key],
        state: state.stack[c.key]
          ? 'installed'
          : busy
            ? 'installing'
            : job?.state === 'failed'
              ? 'failed'
              : 'available',
      })),
    };
  };

  on('get', P('/setup/stack'), (ctx) => {
    if (state.installed) return gone();
    return ok(stackView(ctx));
  });

  on('post', P('/setup/stack:install'), (ctx) => {
    if (state.installed) return gone();
    const view = stackView(ctx);
    if (view.ready)
      return problem(409, 'conflict', 'Web stack đã đủ', 'Không còn thành phần nào cần cài.');
    if (view.components.some((c) => c.state === 'installing'))
      return problem(409, 'resource_locked', 'Đang cài web stack', 'Chờ job cài hiện tại xong.');
    const missing = STACK.filter((c) => !state.stack[c.key]);
    const srv = ctx.db.data.servers[0];
    const reply = startJob(ctx, {
      type: 'setup.stack',
      resource: { type: 'server', uuid: srv?.uuid ?? '' },
      ops: missing.map((c) => c.op),
      server: srv ? { uuid: srv.uuid, name: srv.name } : null,
      onDone: () => {
        for (const c of missing) state.stack[c.key] = c.version;
      },
    });
    state.stackJob = (reply.body as { job: { uuid: string } }).job.uuid;
    return reply;
  });

  // ---- Khôi phục thảm họa (D-87): mở repo panel bằng bộ khôi phục, chọn bản backup panel, khôi phục.
  const sourceError = (b: Partial<S['SetupRestoreSource']>): string | null => {
    if (!b.type || !['local', 'sftp', 's3', 'rest'].includes(b.type)) return 'Chọn loại đích.';
    if (b.type === 'sftp')
      return 'Đích SFTP: chạy "sudo itso backup panel-restore --kit <file> --snapshot <id> --ssh-key <khóa>" rồi "sudo itso panel-restore-apply --dir <thư mục in ra>" (runbook DR).';
    const need: Record<string, string[]> = {
      local: [],
      sftp: ['host', 'user', 'path'],
      s3: ['endpoint', 'bucket'],
      rest: ['url'],
    };
    for (const k of need[b.type] ?? []) if (!b.config?.[k]?.trim()) return `Thiếu cấu hình "${k}".`;
    if (!/^itso\/[0-9a-f-]{36}\/server$/.test(b.repository_path ?? ''))
      return 'Đường dẫn repo server dạng itso/<uuid server>/server (dòng "repo:" của mục "server <tên máy>" trong bộ khôi phục).';
    if ((b.repository_password ?? '').length < 16)
      return 'Mật khẩu repo từ 16 ký tự (trong bộ khôi phục).';
    if (!/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(b.panel_private_key ?? ''))
      return 'Khóa riêng của panel phải có dạng AGE-SECRET-KEY-1… (58 ký tự sau tiền tố).';
    return null;
  };

  on('post', P('/setup/restore:inspect'), (ctx) => {
    if (state.installed) return gone();
    if (!state.verified) return notVerified();
    if (state.admin)
      return problem(
        409,
        'conflict',
        'Đã tạo SUPER_ADMIN',
        'Khôi phục chỉ chọn được trước khi tạo tài khoản quản trị.',
      );
    const b = body<S['SetupRestoreSource']>(ctx);
    const err = sourceError(b);
    if (err) return invalid(err);
    // Demo: mật khẩu repo phải khớp bộ khôi phục mẫu (bản thật: restic mở repo bằng mật khẩu).
    if (b.repository_password !== ctx.db.data.recovery_kit.repositories[0]?.password)
      return invalid('Không mở được repo: mật khẩu sai hoặc repo không tồn tại ở đích này.');
    return ok(ctx.db.data.setup_restore_candidates);
  });

  on('post', P('/setup/restore'), (ctx) => {
    if (state.installed) return gone();
    if (!state.verified) return notVerified();
    if (state.admin)
      return problem(
        409,
        'conflict',
        'Đã tạo SUPER_ADMIN',
        'Khôi phục chỉ chọn được trước khi tạo tài khoản quản trị.',
      );
    const b = body<S['SetupRestoreRequest']>(ctx);
    const err = b.source ? sourceError(b.source) : 'Thiếu nguồn khôi phục.';
    if (err) return invalid(err);
    if (!ctx.db.data.setup_restore_candidates.some((c) => c.snapshot_id === b.snapshot_id))
      return invalid('Chọn một bản backup panel trong danh sách.');
    const srv = ctx.db.data.servers[0];
    return startJob(ctx, {
      type: 'setup.restore',
      resource: { type: 'server', uuid: srv?.uuid ?? '' },
      ops: ['panel.restore'],
      server: srv ? { uuid: srv.uuid, name: srv.name } : null,
      onDone: () => {
        state.installed = true;
      },
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
