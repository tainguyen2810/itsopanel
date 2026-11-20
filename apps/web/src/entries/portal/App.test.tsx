import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { mockFetch, renderWithProviders } from '@/test/render';
import { createMemoryHistory } from '@tanstack/react-router';
import { App } from './App';

const at = (path: string) => createMemoryHistory({ initialEntries: [path] });

describe('portal entry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('render PortalShell, chỉ health API, không gọi endpoint admin', async () => {
    const fetchMock = vi.fn(
      mockFetch({ '/api/v1/system/health': [200, { data: { status: 'ok' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<App history={at('/portal/')} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Tổng quan' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('status-API')).toHaveAttribute('data-state', 'ok'),
    );
    expect(screen.queryByTestId('status-Agent')).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of fetchMock.mock.calls) {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).not.toContain('/admin/');
    }
  });

  it('menu portal chỉ có chức năng của USER, không tìm kiếm toàn hệ thống', async () => {
    vi.stubGlobal('fetch', vi.fn(mockFetch({})));
    renderWithProviders(<App history={at('/portal/')} />);
    const nav = await screen.findByRole('navigation', { name: 'Điều hướng chính' });
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
