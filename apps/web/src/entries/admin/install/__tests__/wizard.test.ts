import { describe, expect, it } from 'vitest';
import {
  accessBody,
  canProceed,
  firstInvalid,
  INITIAL,
  LATER,
  resumeStep,
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
  panelDomain: 'panel.itso.vn',
  entrancePath: '/itso-a7k2',
  allowlist: '10.10.5.0/24\n203.0.113.7\n2001:db8::/32',
};

describe('wizard cài đặt', () => {
  it('có đúng 10 bước theo sitemap; 4 bước chưa có ở bản này', () => {
    expect(STEPS).toHaveLength(10);
    expect(STEPS[0]).toBe('code');
    expect(STEPS.at(-1)).toBe('summary');
    expect(LATER).toEqual(['security', 'backup', 'smtp']);
    expect(canProceed('stack', INITIAL)).toBe(true); // bước stack không bắt buộc
    for (const st of LATER) expect(canProceed(st, INITIAL)).toBe(true);
  });

  it('dữ liệu đầy đủ thì mọi bước hợp lệ', () => {
    expect(firstInvalid(ok)).toBeNull();
  });

  it('mã thiết lập phải đúng dạng XXXX-XXXX-XXXX', () => {
    expect(canProceed('code', { ...ok, setupCode: 'abc' })).toBe(false);
    expect(validate('code', { ...ok, setupCode: '' })).toEqual({ setupCode: 'setupCode' });
  });

  it('Super Admin: email, mật khẩu ≥ 12 ký tự; sau khi tạo chỉ còn kiểm mã TOTP 6 số', () => {
    expect(validate('admin', { ...ok, adminEmail: 'x', adminPassword: 'ngan' })).toEqual({
      adminEmail: 'email',
      adminPassword: 'password',
    });
    expect(
      validate('admin', { ...ok, adminCreated: true, adminPassword: '', mfaCode: '12' }),
    ).toEqual({
      mfaCode: 'mfa',
    });
    expect(canProceed('admin', { ...ok, adminCreated: true, mfaCode: '123456' })).toBe(true);
  });

  it('truy cập panel: domain tùy chọn, cổng 1024–65535, entrance path, allowlist IP/CIDR', () => {
    expect(validate('access', { ...ok, panelPort: 22 })).toEqual({ panelPort: 'port' });
    expect(validate('access', { ...ok, panelPort: 70000 })).toEqual({ panelPort: 'port' });
    expect(validate('access', { ...ok, allowlist: '10.0.0.1\nkhong-phai-ip' })).toEqual({
      allowlist: 'ip',
    });
    expect(validate('access', { ...ok, panelDomain: 'localhost' })).toEqual({
      panelDomain: 'domain',
    });
    expect(validate('access', { ...ok, entrancePath: 'admin' })).toEqual({
      entrancePath: 'entrance',
    });
    expect(canProceed('access', { ...ok, panelDomain: '', entrancePath: '' })).toBe(true);
  });

  it('accessBody: chuỗi rỗng → null, allowlist thành mảng', () => {
    expect(accessBody({ ...ok, panelDomain: ' ', entrancePath: '' })).toEqual({
      panel_domain: null,
      panel_port: 8443,
      entrance_path: null,
      allowlist: ['10.10.5.0/24', '203.0.113.7', '2001:db8::/32'],
    });
  });

  it('resumeStep tiếp tục từ bước đầu tiên chưa xong', () => {
    expect(resumeStep([])).toBe('code');
    expect(resumeStep(['code'])).toBe('language');
    expect(resumeStep(['code', 'language'])).toBe('admin');
    expect(resumeStep(['code', 'language', 'admin', 'access'])).toBe('stack');
    expect(resumeStep(['code', 'language', 'admin', 'access', 'quota'])).toBe('summary');
  });

  it('firstInvalid trả bước đầu tiên còn thiếu', () => {
    expect(firstInvalid({ ...ok, panelPort: 80 })).toBe('access');
    expect(firstInvalid(INITIAL)).toBe('code');
  });

  it('cảnh báo: không allowlist, quota mềm hoặc chưa biết', () => {
    expect(warnings({ ...ok, allowlist: '' }, 'soft')).toEqual(['noAllowlist', 'quotaSoft']);
    expect(warnings(ok, 'unknown')).toEqual(['quotaUnknown']);
    expect(warnings(ok, 'kernel')).toEqual([]);
  });
});
