import type { ReactElement } from 'react';
import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { AppProviders } from '@/shared/AppProviders';
import { createI18n } from '@/shared/i18n';
import type { Locale } from '@/shared/i18n/format';

/** Render với đủ provider (Query, i18n, Theme, Tooltip, Toaster) như entry thật. */
export function renderWithProviders(ui: ReactElement, opts: { lang?: Locale } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const i18n = createI18n(opts.lang ?? 'vi');
  return {
    i18n,
    ...render(
      <AppProviders i18n={i18n} queryClient={queryClient}>
        {ui}
      </AppProviders>,
    ),
  };
}

/** @deprecated giữ tên cũ cho test 1.5 */
export const renderWithQuery = renderWithProviders;

/** Giả lập fetch theo đường dẫn → [status, body]. */
export function mockFetch(routes: Record<string, [number, unknown]>) {
  return (input: RequestInfo | URL): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(raw, 'http://localhost');
    const hit = routes[u.pathname + u.search] ?? [
      404,
      { type: 'about:blank', title: 'Not Found', status: 404, code: 'not_found' },
    ];
    return Promise.resolve(
      new Response(JSON.stringify(hit[1]), {
        status: hit[0],
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
}
