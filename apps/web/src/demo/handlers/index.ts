import { on } from '../router';
import { visibility, canSeeServer, canSeeAccount } from '../scope';
import { registerAdminLists } from './admin';
import { registerCommon } from './common';
import { registerDashboard } from './dashboard';
import { registerDocker } from './docker';
import { registerGovernance } from './governance';
import { registerHosting } from './hosting';
import { registerInfra } from './infra';
import { registerMonitoring } from './monitoring';
import { registerFeatures, registerPortal } from './portal';
import { registerProduction } from './production';
import { registerSecurity } from './security';
import { registerSetup } from './setup';
import { registerSites } from './sites';
import { jobActions, registerAuthWrites } from './writes';

let done = false;
/** Đăng ký mọi handler một lần (module prompt sau thêm handler của mình ở đây). */
export function registerAll() {
  if (done) return;
  done = true;
  registerCommon();
  registerAdminLists();
  registerDashboard();
  registerInfra();
  registerDocker();
  registerHosting();
  registerSites();
  registerGovernance();
  registerFeatures();
  registerPortal();
  registerAuthWrites(on);
  registerSetup();
  registerSecurity();
  registerMonitoring();
  registerProduction();

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
