import { http, HttpResponse, passthrough } from 'msw';
import { registerAll } from './handlers';
import { dispatch } from './router';

registerAll();

/** Một handler MSW cho mọi /api/v1/*: chuyển cho bộ định tuyến theo OpenAPI của demo. */
export const handlers = [
  http.all('*/api/v1/*', async ({ request }) => {
    // Chỉ đường dẫn bắt đầu bằng /api/v1/ (không bắt nhầm module Vite như /src/api/x.ts).
    if (!new URL(request.url).pathname.startsWith('/api/v1/')) return passthrough();
    const r = await dispatch(request);
    if (r === null) {
      return HttpResponse.json(
        {
          type: 'https://docs.itso.local/problems/not-found',
          title: 'Endpoint chưa có trong bản demo',
          status: 404,
          code: 'not_found',
          detail: `${request.method} ${new URL(request.url).pathname}`,
        },
        { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
      );
    }
    if (r.status === 204) return new HttpResponse(null, { status: 204 });
    // Body văn bản (vd. CSV xuất audit log) trả nguyên dạng, không bọc JSON.
    if (typeof r.body === 'string')
      return new HttpResponse(r.body, {
        status: r.status,
        ...(r.headers ? { headers: r.headers } : {}),
      });
    return HttpResponse.json(r.body ?? null, {
      status: r.status,
      ...(r.headers ? { headers: r.headers } : {}),
    });
  }),
  // Tài nguyên tĩnh, HMR… đi thẳng.
  http.all('*', () => passthrough()),
];
