import { registerAdminLists } from './admin';
import { registerCommon } from './common';

let done = false;
/** Đăng ký mọi handler một lần (module prompt sau thêm handler của mình ở đây). */
export function registerAll() {
  if (done) return;
  done = true;
  registerCommon();
  registerAdminLists();
}
