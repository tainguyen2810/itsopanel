import type { ShellUser } from '@/shared/shell/Topbar';

/** Người dùng mẫu cho shell tới khi có auth (Phase 3). Lấy từ contracts/examples/demo-dataset.json. */
export const DEMO_ADMIN: ShellUser = {
  name: 'Quản trị hệ thống',
  email: 'superadmin@itso.local',
  roleLabel: 'Super Admin',
};
export const DEMO_USER: ShellUser = {
  name: 'Công ty An Phát',
  email: 'it@anphat.vn',
  roleLabel: 'anphat',
};
