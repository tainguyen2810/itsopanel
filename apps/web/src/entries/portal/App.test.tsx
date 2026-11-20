import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { mockFetch, renderWithProviders } from '@/test/render';
import { App } from './App';

describe('portal entry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('render PortalShell, chỉ health API, không gọi endpoint admin', async () => {
    const fetchMock = vi.fn(
      mockFetch({ '/api/v1/system/health': [200, { data: { status: 'ok' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Tổng quan' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('status-API')).toHaveAttribute('data-state', 'ok'),
    );
    expect(screen.queryByTestId('status-Agent')).toBeNull();
    for (const call of fetchMock.mock.calls) expect(String(call[0])).not.toContain('/admin/');
  });

  it('menu portal chỉ có chức năng của USER, không tìm kiếm toàn hệ thống', () => {
    vi.stubGlobal('fetch', vi.fn(mockFetch({})));
    renderWithProviders(<App />);
    const nav = screen.getByRole('navigation', { name: 'Điều hướng chính' });
    const hrefs = within(nav)
      .getAllByRole('link')
      .map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.every((h) => h.startsWith('/portal/'))).toBe(true);
    for (const forbidden of [
      'servers',
      'users',
      'hosting-packages',
      'firewall',
      'docker',
      'roles',
    ]) {
      expect(hrefs.some((h) => h.includes(forbidden))).toBe(false);
    }
    expect(screen.queryByRole('button', { name: /Tìm server/ })).toBeNull();
  });
});
