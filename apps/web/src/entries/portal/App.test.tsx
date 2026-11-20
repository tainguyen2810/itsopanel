import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { mockFetch, renderWithQuery } from '@/test/render';
import { App } from './App';

describe('portal entry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('hiển thị health API và không gọi endpoint admin', async () => {
    const fetchMock = vi.fn(
      mockFetch({ '/api/v1/system/health': [200, { data: { status: 'ok' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithQuery(<App />);
    expect(screen.getByRole('heading', { name: 'User Hosting Portal' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('status-API')).toHaveAttribute('data-state', 'ok'),
    );
    expect(screen.queryByTestId('status-Agent')).toBeNull();
    for (const call of fetchMock.mock.calls) expect(String(call[0])).not.toContain('/admin/');
  });
});
