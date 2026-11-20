import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { mockFetch, renderWithProviders } from '@/test/render';
import { createMemoryHistory } from '@tanstack/react-router';
import { App } from './App';

const at = (path: string) => createMemoryHistory({ initialEntries: [path] });

describe('portal entry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('render PortalShell + Tổng quan từ API Portal, không gọi endpoint admin', async () => {
    const fetchMock = vi.fn(
      mockFetch({
        '/api/v1/portal/overview': [
          200,
          { data: { accounts: [], warnings: [], recent_jobs: [], notifications_unread: 2 } },
        ],
        '/api/v1/portal/notifications?limit=200': [
          200,
          {
            data: [
              { uuid: 'n1', read_at: null },
              { uuid: 'n2', read_at: null },
              { uuid: 'n3', read_at: '2026-11-20T00:00:00Z' },
            ],
            meta: { page: 1, per_page: 25, total: 3 },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderWithProviders(<App history={at('/portal/')} />);
    expect(await screen.findByRole('heading', { level: 1, name: /^Xin chào/ })).toBeInTheDocument();
    // Chuông topbar đếm thông báo chưa đọc thật của user (không còn số cố định).
    expect(
      await screen.findByRole('button', { name: 'Thông báo: 2 thông báo chưa đọc' }),
    ).toBeInTheDocument();
    // Trạng thái agent là thông tin hạ tầng, chỉ Admin thấy.
    expect(screen.queryByTestId('status-Agent')).toBeNull();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
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
