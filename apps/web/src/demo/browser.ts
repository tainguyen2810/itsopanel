import { setupWorker } from 'msw/browser';
import { adminApi } from '@/api/admin';
import { portalApi } from '@/api/portal';
import { currentPersona, type Realm } from '@/shared/session/personas';
import { handlers } from './msw';

/** Gắn người dùng demo vào mọi request (MSW đọc X-Demo-User để áp phạm vi theo vai trò). */
function demoHeaders(realm: Realm) {
  return {
    onRequest({ request }: { request: Request }) {
      request.headers.set('X-Demo-User', currentPersona(realm).uuid);
      request.headers.set('X-Demo-Realm', realm);
      return request;
    },
  };
}

/** Bật API giả lập trong trình duyệt (chỉ ở chế độ demo: VITE_DEMO=1). */
export async function startDemo() {
  adminApi.use(demoHeaders('admin'));
  portalApi.use(demoHeaders('portal'));
  const worker = setupWorker(...handlers);
  await worker.start({
    serviceWorker: { url: '/mockServiceWorker.js' },
    onUnhandledFrame: 'bypass',
    quiet: true,
  });
}
