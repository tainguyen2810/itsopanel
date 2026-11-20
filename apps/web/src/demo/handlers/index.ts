import { on } from '../router';
import { visibility, canSeeServer, canSeeAccount } from '../scope';
import { registerAdminLists } from './admin';
import { registerCommon } from './common';
import { registerDashboard } from './dashboard';
import { jobActions, registerAuthWrites } from './writes';

let done = false;
/** Đăng ký mọi handler một lần (module prompt sau thêm handler của mình ở đây). */
export function registerAll() {
  if (done) return;
  done = true;
  registerCommon();
  registerAdminLists();
  registerDashboard();
  registerAuthWrites(on);

  // Hủy / chạy lại job: ADMIN chỉ job thuộc server hoặc account trong phạm vi.
  for (const action of ['cancel', 'retry'] as const) {
    on('post', `/api/v1/admin/jobs/{id}:${action}`, (ctx) => {
      const v = visibility(ctx.db, ctx.actor);
      return jobActions(
        ctx,
        action,
        (j) =>
          v.all ||
          (j.server !== null && canSeeServer(v, j.server.uuid)) ||
          (j.resource?.type === 'hosting_account' && canSeeAccount(v, j.resource.uuid)),
      );
    });
  }
}
