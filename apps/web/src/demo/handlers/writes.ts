import type { DemoDb, Job, ResourceType } from '../db';
import { noContent, ok, problem, type Ctx, type Reply } from '../router';
import { checkLogin } from './security';

/** Người thực hiện (dạng UserRef) từ actor của request. */
export const actorRef = (ctx: Ctx) => ({
  uuid: ctx.actor.uuid,
  name: ctx.actor.name,
  email: ctx.actor.email,
});

/**
 * Thao tác ghi chạm Linux: tạo job giả lập (chạy từng bước theo thời gian), ghi audit,
 * trả 202 + JobAccepted. `onDone` cập nhật dữ liệu khi job xong (observed = desired).
 */
export function startJob(
  ctx: Ctx,
  opts: {
    type: string;
    resource: { type: ResourceType; uuid: string };
    ops: string[];
    server?: { uuid: string; name: string } | null;
    failAt?: number;
    onDone?: (db: DemoDb) => void;
    changes?: Record<string, unknown>;
  },
): Reply {
  const job = ctx.db.createJob({
    type: opts.type,
    resource: opts.resource,
    ops: opts.ops,
    server: opts.server ?? null,
    requestedBy: actorRef(ctx),
    ...(opts.failAt === undefined ? {} : { failAt: opts.failAt }),
    ...(opts.onDone ? { onDone: opts.onDone } : {}),
  });
  ctx.db.audit({
    actor: actorRef(ctx),
    action: opts.type,
    resource: opts.resource,
    server: opts.server ?? null,
    jobUuid: job.uuid,
    ...(opts.changes ? { changes: opts.changes } : {}),
  });
  return { status: 202, body: { job, resource: opts.resource } };
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

/** Hủy/thử lại job (admin và portal dùng chung, portal chỉ job của mình). */
export function jobActions(
  ctx: Ctx,
  action: 'cancel' | 'retry',
  visible: (j: Job) => boolean,
): Reply {
  const job = ctx.db.data.jobs.find((j) => j.uuid === ctx.params.id);
  if (!job || !visible(job)) return problem(404, 'not_found', 'Không tìm thấy job');
  if (action === 'cancel') {
    if (TERMINAL.has(job.state)) return problem(409, 'conflict', 'Job đã kết thúc, không thể hủy');
    job.state = 'cancel_requested';
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'job.cancel',
      resource: job.resource,
      server: job.server,
      jobUuid: job.uuid,
    });
    return ok(job);
  }
  if (!['failed', 'cancelled', 'timed_out'].includes(job.state)) {
    return problem(409, 'conflict', 'Chỉ chạy lại được job thất bại hoặc đã hủy');
  }
  if (!job.resource)
    return problem(409, 'conflict', 'Job không gắn tài nguyên, không chạy lại được');
  return startJob(ctx, {
    type: job.type,
    resource: job.resource,
    ops: job.steps.map((s) => s.op),
    server: job.server,
    changes: { retry_of: job.uuid },
  });
}

/** Đăng nhập demo: không xác thực thật; tài khoản có MFA đi tiếp bước mã TOTP. */
export function registerAuthWrites(on: typeof import('../router').on) {
  const meOf = (ctx: Ctx) => {
    const user = ctx.db.data.users.find((u) => u.uuid === ctx.actor.uuid);
    return { user, mfaEnabled: user?.mfa_enabled ?? false };
  };

  on('post', '/api/v1/auth/login', async (ctx) => {
    const body = ctx.body as
      | { email?: string; password?: string; captcha?: { challenge?: string; nonce?: string } }
      | undefined;
    if (!body?.email || !body.password) {
      return problem(422, 'validation_failed', 'Dữ liệu không hợp lệ', 'Cần email và mật khẩu.');
    }
    // Phase 7: mật khẩu `wrong-password` coi là sai; sai quá ngưỡng thì cần CAPTCHA (D-81).
    const deny = await checkLogin(ctx, {
      email: body.email,
      password: body.password,
      captcha: body.captcha,
    });
    if (deny) return deny;
    const { mfaEnabled } = meOf(ctx);
    return ok({ mfa_required: mfaEnabled, mfa_methods: mfaEnabled ? ['totp', 'recovery'] : [] });
  });

  const verify = (ctx: Ctx): Reply | null => {
    const code = (ctx.body as { code?: string } | undefined)?.code ?? '';
    // Demo: mã 000000 coi là sai để thử trạng thái lỗi; mã 6 số khác đều đúng.
    if (!/^([0-9]{6}|[a-z0-9]{10})$/.test(code) || code === '000000') {
      return problem(
        422,
        'validation_failed',
        'Mã xác thực không đúng',
        'Kiểm tra lại mã trong ứng dụng xác thực.',
      );
    }
    return null;
  };
  const me = (ctx: Ctx) => {
    const { user } = meOf(ctx);
    return ok({
      user,
      permissions: ctx.actor.role === 'SUPER_ADMIN' ? ['*'] : [],
      scopes: [],
      mfa_verified_at: ctx.db.now(),
      impersonating: null,
    });
  };
  on('post', '/api/v1/auth/mfa/verify', (ctx) => verify(ctx) ?? me(ctx));
  on('post', '/api/v1/auth/step-up', (ctx) => verify(ctx) ?? me(ctx));
  on('post', '/api/v1/auth/logout', () => noContent());

  on('post', '/api/v1/auth/password:change', (ctx) => {
    const b = ctx.body as { current_password?: string; new_password?: string } | undefined;
    if (!b?.new_password || b.new_password.length < 12) {
      return problem(422, 'validation_failed', 'Mật khẩu mới chưa đủ mạnh', 'Tối thiểu 12 ký tự.');
    }
    ctx.db.audit({
      actor: actorRef(ctx),
      action: 'user.password_change',
      resource: { type: 'user', uuid: ctx.actor.uuid },
    });
    return noContent();
  });

  on('post', '/api/v1/auth/mfa/totp:enroll', () =>
    ok({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauth_uri: 'otpauth://totp/ITSO%20Panel:demo?secret=JBSWY3DPEHPK3PXP&issuer=ITSO%20Panel',
      recovery_codes: [
        'a1b2c3d4e5',
        'f6g7h8i9j0',
        'k1l2m3n4o5',
        'p6q7r8s9t0',
        'u1v2w3x4y5',
        'z6a7b8c9d0',
      ],
    }),
  );
  on('post', '/api/v1/auth/mfa/totp:confirm', (ctx) => {
    const bad = verify(ctx);
    if (bad) return bad;
    const user = ctx.db.data.users.find((u) => u.uuid === ctx.actor.uuid);
    if (user) user.mfa_enabled = true;
    return noContent();
  });

  on('delete', '/api/v1/auth/sessions/{id}', (ctx) => {
    const list = ctx.db.data.sessions;
    const i = list.findIndex((s) => s.uuid === ctx.params.id);
    if (i < 0) return problem(404, 'not_found', 'Không tìm thấy phiên');
    if (list[i]?.current)
      return problem(409, 'conflict', 'Không thể thu hồi phiên hiện tại; hãy đăng xuất');
    list.splice(i, 1);
    return noContent();
  });
}
