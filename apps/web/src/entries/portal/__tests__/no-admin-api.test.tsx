import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { resetDb } from '@/demo/db';
import { demoServer } from '@/demo/node';
import { renderWithProviders } from '@/test/render';
import { App } from '../App';
import { PORTAL_ROUTES } from '../routes';

// Prompt 2.7: mọi trang Portal chỉ gọi API Portal (không bao giờ /api/v1/admin/), chạy trên API
// giả lập demo (MSW, người dùng mặc định là chủ account anphat).
const ANPHAT = '01938a05-0001-7000-8000-000005000001';
const SITE = '01938a06-0001-7000-8000-000006000001';
const JOB = '01938a0f-0001-7000-8000-00000f000001';
const IDS: Record<string, string> = { accounts: ANPHAT, websites: SITE, jobs: JOB };

const urlOf = (path: string) => {
  const segs = path.split('/');
  return segs.map((s, i) => (s.startsWith('$') ? (IDS[segs[i - 1] ?? ''] ?? s) : s)).join('/');
};

const seen: string[] = [];
let pending = 0;
const track = ({ request }: { request: Request }) => {
  seen.push(new URL(request.url).pathname);
  pending += 1;
};
const done = () => {
  pending -= 1;
};

beforeAll(() => {
  demoServer.listen({ onUnhandledFrame: 'bypass' });
  demoServer.events.on('request:start', track);
  demoServer.events.on('response:mocked', done);
  demoServer.events.on('response:bypass', done);
});
beforeEach(() => {
  resetDb();
  seen.length = 0;
  pending = 0;
});
afterAll(() => {
  demoServer.events.removeAllListeners();
  demoServer.close();
});

describe('Portal không gọi API Admin', () => {
  it.each(PORTAL_ROUTES.map((r) => [r.id, urlOf(`/portal${r.path}`), r.bare === true] as const))(
    '%s (%s)',
    async (_id, url, bare) => {
      renderWithProviders(<App history={createMemoryHistory({ initialEntries: [url] })} />);
      const h1 = await screen.findByRole('heading', { level: 1 }, { timeout: 5000 });
      expect(h1).not.toHaveTextContent(/Không tìm thấy trang|Bạn không có quyền/);
      // Chờ các truy vấn của trang chạy xong.
      await waitFor(() => expect(pending).toBe(0));
      await new Promise((ok) => setTimeout(ok, 50));
      await waitFor(() => expect(pending).toBe(0));

      const api = seen.filter((p) => p.startsWith('/api/'));
      // Trang đăng nhập/quên mật khẩu không gọi API khi mở; mọi trang còn lại phải tải dữ liệu.
      if (!bare) expect(api.length).toBeGreaterThan(0);
      expect(api.filter((p) => p.includes('/admin/'))).toEqual([]);
      expect(api.every((p) => /^\/api\/v1\/(portal|system|auth)\b/.test(p))).toBe(true);
    },
  );

  it('đăng nhập portal gọi /auth/login rồi vào Tổng quan, không chạm API Admin', async () => {
    const history = createMemoryHistory({ initialEntries: ['/portal/login'] });
    renderWithProviders(<App history={history} />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'it@anphat.vn' } });
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'demo-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    // Account có MFA → bước xác thực; không có → Tổng quan. Cả hai đều trong /portal.
    await waitFor(() => expect(history.location.pathname).toMatch(/^\/portal\/(login\/mfa)?$/));
    expect(seen).toContain('/api/v1/auth/login');
    expect(seen.filter((p) => p.includes('/admin/'))).toEqual([]);
  });

  it('trang dữ liệu dùng API Portal theo đúng account của user', async () => {
    renderWithProviders(
      <App history={createMemoryHistory({ initialEntries: [`/portal/accounts/${ANPHAT}`] })} />,
    );
    await screen.findByRole('heading', { level: 1, name: /anphat/ }, { timeout: 5000 });
    await waitFor(() => expect(seen).toContain(`/api/v1/portal/hosting-accounts/${ANPHAT}`));
  });
});
