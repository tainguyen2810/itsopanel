import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';

export function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Giả lập fetch theo đường dẫn → [status, body]. */
export function mockFetch(routes: Record<string, [number, unknown]>) {
  return (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hit = routes[url] ?? [
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
