import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { mockFetch, renderWithQuery } from '@/test/render';
import { App } from './App';

const status = {
  api: 'ok',
  database: { ok: true, latency_ms: 1.2, error: null },
  redis: { ok: true, latency_ms: 0.3, error: null },
  agent: { reachable: true, mode: 'mock', version: '0.1.0-mock', latency_ms: 2, error: null },
  checked_at: '2026-11-20T00:00:00Z',
};

describe('admin entry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hiển thị health API và ping agent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        mockFetch({
          '/api/v1/system/health': [200, { data: { status: 'ok' } }],
          '/api/v1/admin/system/status': [200, { data: status }],
        }),
      ),
    );
    renderWithQuery(<App />);
    expect(screen.getByRole('heading', { name: 'Private Admin Panel' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('status-API')).toHaveAttribute('data-state', 'ok'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('status-Agent')).toHaveAttribute('data-state', 'ok'),
    );
    expect(screen.getByTestId('status-Agent')).toHaveTextContent('ping mock 0.1.0-mock');
  });

  it('báo lỗi khi API trả problem+json', async () => {
    vi.stubGlobal('fetch', vi.fn(mockFetch({})));
    renderWithQuery(<App />);
    await waitFor(() =>
      expect(screen.getByTestId('status-API')).toHaveAttribute('data-state', 'error'),
    );
    expect(screen.getByTestId('status-Agent')).toHaveTextContent('Not Found');
  });
});
