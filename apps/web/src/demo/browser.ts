import { setupWorker } from 'msw/browser';
import { handlers } from './msw';

/** Bật API giả lập trong trình duyệt (chỉ ở chế độ demo: VITE_DEMO=1). */
export async function startDemoWorker() {
  const worker = setupWorker(...handlers);
  await worker.start({
    serviceWorker: { url: '/mockServiceWorker.js' },
    onUnhandledFrame: 'bypass',
    quiet: true,
  });
}
