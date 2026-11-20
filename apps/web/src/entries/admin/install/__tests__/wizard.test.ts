import { describe, expect, it } from 'vitest';
import {
  canProceed,
  firstInvalid,
  INITIAL,
  STEPS,
  validate,
  warnings,
  type InstallState,
} from '../wizard';

const ok: InstallState = {
  ...INITIAL,
  setupCode: 'ab12-cd34-ef56',
  adminName: 'Quản trị',
  adminEmail: 'admin@itso.vn',
  adminPassword: 'mat-khau-rat-dai',
  mfaCode: '123456',
  panelDomain: 'panel.itso.vn',
  allowlist: '10.10.5.0/24\n203.0.113.7',
  smtpHost: 'smtp.itso.vn',
  smtpFrom: 'panel@itso.vn',
};

describe('wizard cài đặt', () => {
  it('có đúng 10 bước theo sitemap', () => {
    expect(STEPS).toHaveLength(10);
    expect(STEPS[0]).toBe('code');
    expect(STEPS.at(-1)).toBe('summary');
  });

  it('dữ liệu đầy đủ thì mọi bước hợp lệ', () => {
    expect(firstInvalid(ok)).toBeNull();
  });

  it('mã thiết lập phải đúng dạng XXXX-XXXX-XXXX', () => {
    expect(canProceed('code', { ...ok, setupCode: 'abc' })).toBe(false);
    expect(validate('code', { ...ok, setupCode: '' })).toEqual({ setupCode: 'setupCode' });
  });

  it('Super Admin: email, mật khẩu ≥ 12 ký tự, mã MFA 6 số', () => {
    expect(
      validate('admin', { ...ok, adminEmail: 'x', adminPassword: 'ngan', mfaCode: '12' }),
    ).toEqual({
      adminEmail: 'email',
      adminPassword: 'password',
      mfaCode: 'mfa',
    });
  });

  it('truy cập panel: domain, cổng không trùng 22/80, allowlist là IPv4/CIDR', () => {
    expect(validate('access', { ...ok, panelPort: 22 })).toEqual({ panelPort: 'port' });
    expect(validate('access', { ...ok, allowlist: '10.0.0.1\nkhong-phai-ip' })).toEqual({
      allowlist: 'ip',
    });
    expect(validate('access', { ...ok, panelDomain: 'localhost' })).toEqual({
      panelDomain: 'domain',
    });
  });

  it('stack cần ít nhất một bản PHP; backup ngoài cần đích, local cần đường dẫn tuyệt đối', () => {
    expect(canProceed('stack', { ...ok, php: [] })).toBe(false);
    expect(validate('backup', { ...ok, backupType: 's3', backupTarget: '' })).toEqual({
      backupTarget: 'required',
    });
    expect(validate('backup', { ...ok, backupTarget: 'backups' })).toEqual({
      backupTarget: 'path',
    });
  });

  it('bỏ qua SMTP thì không kiểm SMTP nhưng có cảnh báo', () => {
    const s = { ...ok, smtpSkip: true, smtpHost: '' };
    expect(canProceed('smtp', s)).toBe(true);
    expect(warnings(s)).toContain('noSmtp');
  });

  it('firstInvalid trả bước đầu tiên còn thiếu', () => {
    expect(firstInvalid({ ...ok, panelDomain: '' })).toBe('access');
    expect(firstInvalid(INITIAL)).toBe('code');
  });

  it('cảnh báo cấu hình kém an toàn', () => {
    expect(warnings({ ...ok, allowlist: '', sshPasswordAuth: true, firewall: false })).toEqual(
      expect.arrayContaining(['noAllowlist', 'sshPassword', 'noFirewall']),
    );
  });
});
