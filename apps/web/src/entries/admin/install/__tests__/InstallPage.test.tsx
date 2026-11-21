import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { resetDb } from '@/demo/db';
import { DEMO_SETUP_CODE, resetDemoSetup } from '@/demo/handlers/setup';
import { demoServer } from '@/demo/node';
import { renderWithProviders } from '@/test/render';
import { App } from '../../App';

// Prompt 4.5: wizard /admin/install gọi /api/v1/admin/setup/* (API giả lập demo theo OpenAPI).

const seen: string[] = [];
const track = ({ request }: { request: Request }) => {
  seen.push(`${request.method} ${new URL(request.url).pathname}`);
};

beforeAll(() => {
  demoServer.listen({ onUnhandledFrame: 'bypass' });
  demoServer.events.on('request:start', track);
});
beforeEach(() => {
  resetDb();
  resetDemoSetup();
  seen.length = 0;
});
afterAll(() => {
  demoServer.events.removeAllListeners();
  demoServer.close();
});

const next = () => fireEvent.click(screen.getByRole('button', { name: /Tiếp tục/ }));
const heading = (name: string) =>
  screen.findByRole('heading', { level: 2, name }, { timeout: 5000 });

describe('Wizard cài đặt dùng API thật', () => {
  it('đi hết 10 bước: mã → ngôn ngữ → SA + TOTP → truy cập → quota → khóa', async () => {
    const history = createMemoryHistory({ initialEntries: ['/admin/install'] });
    renderWithProviders(<App history={history} />);
    await heading('Mã thiết lập');

    fireEvent.change(screen.getByRole('textbox', { name: 'Mã thiết lập' }), {
      target: { value: 'AAAA-BBBB-CCCC' },
    });
    next();
    expect(await screen.findByText('Mã thiết lập không đúng.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Mã thiết lập' }), {
      target: { value: DEMO_SETUP_CODE },
    });
    next();
    await heading('Ngôn ngữ');
    next();

    await heading('Super Admin và MFA');
    fireEvent.change(screen.getByRole('textbox', { name: 'Họ tên' }), {
      target: { value: 'Quản trị đầu tiên' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: 'root@itso.local' },
    });
    fireEvent.change(screen.getByLabelText('Mật khẩu'), {
      target: { value: 'mat-khau-rat-dai-2026' },
    });
    next();
    expect(await screen.findByText(/Đã tạo Super Admin root@itso.local/)).toBeInTheDocument();
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    next(); // thiếu mã TOTP → lỗi tại chỗ, không gọi API
    expect(await screen.findByText('Nhập đủ 6 số')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Mã 6 số' }), {
      target: { value: '123456' },
    });
    next();

    await heading('Truy cập panel');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Cổng HTTPS' }), {
      target: { value: '80' },
    });
    next();
    expect(await screen.findByText(/Cổng từ 1024 đến 65535/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Cổng HTTPS' }), {
      target: { value: '8443' },
    });
    fireEvent.change(screen.getByLabelText('IP allowlist cho Admin Panel'), {
      target: { value: '10.10.5.0/24' },
    });
    next();

    for (const later of ['Stack', 'Bảo mật']) {
      await heading(later);
      expect(screen.getByText('Chưa có ở bản này')).toBeInTheDocument();
      next();
    }
    await heading('Quota');
    expect(await screen.findByText('Disk quota của kernel đang bật')).toBeInTheDocument();
    next();
    for (const later of ['Sao lưu', 'Email (SMTP)']) {
      await heading(later);
      next();
    }
    await heading('Tổng kết');
    expect(screen.getByText('https://<IP>:8443')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Hoàn tất cài đặt/ }));
    await waitFor(() => expect(history.location.pathname).not.toBe('/admin/install'));

    expect(seen).toEqual(
      expect.arrayContaining([
        'POST /api/v1/admin/setup/code:verify',
        'PUT /api/v1/admin/setup/preferences',
        'POST /api/v1/admin/setup/admin',
        'POST /api/v1/auth/mfa/totp:enroll',
        'POST /api/v1/auth/mfa/totp:confirm',
        'PUT /api/v1/admin/setup/access',
        'GET /api/v1/admin/setup/quota',
        'POST /api/v1/admin/setup:complete',
      ]),
    );
  });

  it('panel đã cài: hiện thông báo khóa và lệnh đặt lại mật khẩu, không hiện wizard', async () => {
    // Đi nhanh qua API demo để khóa wizard.
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`http://localhost${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    await call('POST', '/api/v1/admin/setup/code:verify', { code: DEMO_SETUP_CODE });
    await call('POST', '/api/v1/admin/setup/admin', {
      name: 'A B',
      email: 'a@itso.local',
      password: 'mat-khau-rat-dai-2026',
    });
    await call('PUT', '/api/v1/admin/setup/access', {
      panel_domain: null,
      panel_port: 8443,
      entrance_path: null,
      allowlist: [],
    });
    expect((await call('POST', '/api/v1/admin/setup:complete')).status).toBe(200);
    expect(
      (await call('POST', '/api/v1/admin/setup/code:verify', { code: DEMO_SETUP_CODE })).status,
    ).toBe(410);

    renderWithProviders(
      <App history={createMemoryHistory({ initialEntries: ['/admin/install'] })} />,
    );
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Panel đã được cài đặt' },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('sudo itso admin reset-password <email>')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Tiếp tục/ })).toBeNull();
  });
});
