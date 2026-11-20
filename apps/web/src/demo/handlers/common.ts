import { page } from '../list';
import { ok, on } from '../router';
import { scopesOf } from '../scope';

/** Endpoint dùng chung admin/portal: health, phiên đăng nhập, thông tin "tôi". */
export function registerCommon() {
  on('get', '/api/v1/system/health', () => ({ status: 200, body: { data: { status: 'ok' } } }));

  on('get', '/api/v1/auth/me', (ctx) => {
    const user = ctx.db.data.users.find((u) => u.uuid === ctx.actor.uuid);
    const permissions =
      ctx.actor.role === 'SUPER_ADMIN'
        ? ['*']
        : ctx.actor.role === 'USER'
          ? ['own.*']
          : roleOf(ctx.db.data.roles, 'ADMIN');
    return ok({
      user,
      permissions,
      scopes: scopesOf(ctx.db, ctx.actor),
      mfa_verified_at: user?.mfa_enabled ? ctx.db.now() : null,
      impersonating: null,
    });
  });

  on('get', '/api/v1/auth/sessions', (ctx) =>
    page(ctx, ctx.db.data.sessions as Record<string, unknown>[]),
  );
}

function roleOf(roles: unknown, key: string): string[] {
  const r = (roles as { key: string; permissions: string[] }[]).find((x) => x.key === key);
  return r?.permissions ?? [];
}
