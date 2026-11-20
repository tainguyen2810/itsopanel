import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { mockFetch, renderWithProviders } from '@/test/render';
import { createMemoryHistory } from '@tanstack/react-router';
import { App } from './App';

const at = (path: string) => createMemoryHistory({ initialEntries: [path] });

const status = {
  api: 'ok',
  database: { ok: true, latency_ms: 1.2, error: null },
  redis: { ok: true, latency_ms: 0.3, error: null },
  agent: { reachable: true, mode: 'mock', version: '0.1.0-mock', latency_ms: 2, error: null },
  checked_at: '2026-11-20T00:00:00Z',
};

describe('admin entry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('render AdminShell + health API + ping agent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        mockFetch({
          '/api/v1/system/health': [200, { data: { status: 'ok' } }],
          '/api/v1/admin/system/status': [200, { data: status }],
        }),
      ),
    );
    renderWithProviders(<App history={at('/admin/dashboard')} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: /^Chào mừng trở lại/ }),
    ).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getByRole('link', { name: /^Máy chủ/ })).toHaveAttribute(
      'href',
      '/admin/servers',
    );
    expect(within(nav).getByRole('link', { current: 'page' })).toHaveTextContent('Bảng điều khiển');
    expect(screen.getByRole('button', { name: /Tìm server/ })).toBeInTheDocument();
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
    renderWithProviders(<App history={at('/admin/dashboard')} />);
    await waitFor(() =>
      expect(screen.getByTestId('status-API')).toHaveAttribute('data-state', 'error'),
    );
    expect(screen.getByTestId('status-Agent')).toHaveTextContent('Not Found');
  });

  it('hiển thị tiếng Anh khi chọn en', async () => {
    vi.stubGlobal('fetch', vi.fn(mockFetch({})));
    renderWithProviders(<App history={at('/admin/dashboard')} />, { lang: 'en' });
    expect(
      await screen.findByRole('heading', { level: 1, name: /^Welcome back/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it('/ chuyển tới /dashboard; route chưa làm hiện trang tạm có breadcrumb', async () => {
    vi.stubGlobal('fetch', vi.fn(mockFetch({})));
    const history = at('/admin/');
    renderWithProviders(<App history={history} />);
    await screen.findByRole('heading', { level: 1, name: /^Chào mừng trở lại/ });
    expect(history.location.pathname).toBe('/admin/dashboard');

    history.push('/admin/servers/01938a02-0001-7000-8000-000002000001/nginx');
    expect(await screen.findByRole('heading', { level: 1, name: 'Nginx' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Đường dẫn' });
    expect(within(crumbs).getByRole('link', { name: 'Máy chủ' })).toHaveAttribute(
      'href',
      '/admin/servers',
    );
    expect(within(crumbs).getByRole('link', { name: '01938a02…' })).toHaveAttribute(
      'href',
      '/admin/servers/01938a02-0001-7000-8000-000002000001',
    );
    const nav = screen.getByRole('navigation', { name: 'Điều hướng chính' });
    expect(within(nav).getByRole('link', { current: 'page' })).toHaveTextContent('Máy chủ');
  });

  it('guard theo vai trò: ADMIN vào trang chỉ dành cho SUPER_ADMIN thấy 403', async () => {
    vi.stubGlobal('fetch', vi.fn(mockFetch({})));
    localStorage.setItem('itso.demo.actor.admin', '01938a01-0002-7000-8000-000001000002');
    renderWithProviders(<App history={at('/admin/settings')} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bạn không có quyền xem trang này' }),
    ).toBeInTheDocument();
  });

  it('SUPER_ADMIN vào được trang Cài đặt hệ thống', async () => {
    vi.stubGlobal('fetch', vi.fn(mockFetch({})));
    renderWithProviders(<App history={at('/admin/settings')} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Cài đặt hệ thống' }),
    ).toBeInTheDocument();
  });

  it('đường dẫn không tồn tại hiện trang 404', async () => {
    vi.stubGlobal('fetch', vi.fn(mockFetch({})));
    renderWithProviders(<App history={at('/admin/khong-co')} />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Không tìm thấy trang' }),
    ).toBeInTheDocument();
  });
});
