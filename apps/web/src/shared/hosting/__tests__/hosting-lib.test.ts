import { describe, expect, it } from 'vitest';
import { describeCron, minInterval, nextRuns, parseCron } from '../cron';
import {
  contentError,
  dnsProviderSchema,
  dnsRecordSchema,
  dnsZoneBody,
  dnsZoneSchema,
  isIPv6,
  NO_ACCOUNT,
} from '../dns';
import {
  crumbs,
  isInside,
  isTextFile,
  isValidName,
  joinPath,
  modeString,
  normalizePath,
  parentPath,
} from '../paths';

describe('đường dẫn File Manager (chỉ trong home)', () => {
  const home = '/home/anphat';
  it.each([
    ['', '.'],
    ['.', '.'],
    ['~', '.'],
    ['sites/anphat.vn', 'sites/anphat.vn'],
    ['./sites//anphat.vn/', 'sites/anphat.vn'],
    ['sites/a/../b', 'sites/b'],
    ['~/logs', 'logs'],
    ['/home/anphat', '.'],
    ['/home/anphat/sites/x', 'sites/x'],
  ])('chuẩn hóa %j → %j', (input, out) => {
    expect(normalizePath(input, home)).toBe(out);
  });

  it.each([
    '..',
    '../anphat2',
    'sites/../../etc',
    '/etc/passwd',
    '/home/anphat2/x',
    '/home/anphatx',
    'a\u0000b',
    'a\nb',
  ])('chặn %j (ra ngoài home hoặc ký tự điều khiển)', (input) => {
    expect(normalizePath(input, home)).toBeNull();
  });

  it('đường dẫn tuyệt đối không biết home → chặn', () => {
    expect(normalizePath('/home/anphat/x')).toBeNull();
  });

  it('tên file hợp lệ', () => {
    expect(isValidName('index.php')).toBe(true);
    expect(isValidName('.env')).toBe(true);
    for (const n of ['', '.', '..', 'a/b', 'x\ty', 'a'.repeat(256)])
      expect(isValidName(n)).toBe(false);
  });

  it('ghép, cha, breadcrumb, nằm trong', () => {
    expect(joinPath('.', 'a')).toBe('a');
    expect(joinPath('a', 'b')).toBe('a/b');
    expect(parentPath('a/b/c')).toBe('a/b');
    expect(parentPath('a')).toBe('.');
    expect(parentPath('.')).toBe('.');
    expect(crumbs('sites/a', 'home')).toEqual([
      ['.', 'home'],
      ['sites', 'sites'],
      ['sites/a', 'a'],
    ]);
    expect(isInside('sites/a/b', 'sites/a')).toBe(true);
    expect(isInside('sites/ab', 'sites/a')).toBe(false);
  });

  it('file văn bản và quyền', () => {
    expect(isTextFile('index.php')).toBe(true);
    expect(isTextFile('.env')).toBe(true);
    expect(isTextFile('logo.png')).toBe(false);
    expect(modeString('0750')).toBe('rwxr-x---');
    expect(modeString('644')).toBe('rw-r--r--');
  });
});

describe('biểu thức cron', () => {
  it.each([
    '* * * * *',
    '*/15 * * * *',
    '0 2 * * *',
    '30 3 * * 0',
    '0 9-17/2 * * 1-5',
    '0 0 1,15 * *',
    '5 4 * * 7',
  ])('hợp lệ: %s', (e) => expect(parseCron(e).ok).toBe(true));
  it.each([
    ['* * * *', 'fields'],
    ['60 * * * *', 'range'],
    ['* 24 * * *', 'range'],
    ['* * 0 * *', 'range'],
    ['* * * 13 *', 'range'],
    ['* * * * 8', 'range'],
    ['*/0 * * * *', 'range'],
    ['5-1 * * * *', 'range'],
    ['a * * * *', 'syntax'],
    ['@daily * * * *', 'syntax'],
  ])('không hợp lệ: %s → %s', (e, err) => {
    const r = parseCron(e);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(err);
  });

  it('lần chạy kế tiếp', () => {
    const from = new Date(2026, 10, 20, 8, 7); // 20/11/2026 08:07 (thứ Sáu)
    const fmt = (d: Date) =>
      `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    expect(nextRuns('*/15 * * * *', from, 3).map(fmt)).toEqual(['20 8:15', '20 8:30', '20 8:45']);
    expect(nextRuns('0 2 * * *', from, 2).map(fmt)).toEqual(['21 2:00', '22 2:00']);
    expect(nextRuns('30 3 * * 0', from, 1).map(fmt)).toEqual(['22 3:30']); // Chủ nhật
    expect(nextRuns('0 0 31 2 *', from, 1)).toEqual([]); // không bao giờ chạy
  });

  it('khoảng cách nhỏ nhất để so với giới hạn gói', () => {
    expect(minInterval('*/5 * * * *')).toBe(5);
    expect(minInterval('0,1 * * * *')).toBe(1);
    expect(minInterval('0 2 * * *')).toBe(1440);
  });

  it('mô tả mẫu phổ biến', () => {
    expect(describeCron('* * * * *')).toEqual({ key: 'everyMinute' });
    expect(describeCron('*/15 * * * *')).toEqual({ key: 'everyNMinutes', n: 15 });
    expect(describeCron('5 * * * *')).toEqual({ key: 'hourly', minute: 5 });
    expect(describeCron('0 */6 * * *')).toEqual({ key: 'everyNHours', n: 6, minute: 0 });
    expect(describeCron('0 2 * * *')).toEqual({ key: 'daily', time: '02:00' });
    expect(describeCron('30 3 * * 7')).toEqual({ key: 'weekly', time: '03:30', weekday: 0 });
    expect(describeCron('0 4 1 * *')).toEqual({ key: 'monthly', time: '04:00', day: 1 });
    expect(describeCron('0 9-17 * * 1-5')).toEqual({ key: 'custom' });
  });
});

describe('form record DNS', () => {
  const base = { type: 'A' as const, name: '@', content: '203.0.113.10', ttl: 300, proxied: false };
  const err = (v: object) =>
    Object.fromEntries(
      (dnsRecordSchema.safeParse({ ...base, ...v }).error?.issues ?? []).map((i) => [
        i.path.join('.'),
        i.message,
      ]),
    );

  it('nội dung theo loại', () => {
    expect(contentError('A', '10.0.0.1')).toBeNull();
    expect(contentError('A', '256.0.0.1')).toBe('ipv4');
    expect(contentError('AAAA', '2001:db8::1')).toBeNull();
    expect(contentError('AAAA', '2001:db8:::1')).toBe('ipv6');
    expect(contentError('CNAME', 'anphat.vn.')).toBeNull();
    expect(contentError('CNAME', '1.2.3.4')).toBe('hostname');
    expect(contentError('MX', 'mail.anphat.vn')).toBeNull();
    expect(contentError('SRV', '10 5060 sip.anphat.vn')).toBeNull();
    expect(contentError('SRV', '10 99999 sip.anphat.vn')).toBe('srv');
    expect(contentError('CAA', '0 issue "letsencrypt.org"')).toBeNull();
    expect(contentError('CAA', 'issue letsencrypt.org')).toBe('caa');
    expect(contentError('TXT', 'x'.repeat(2049))).toBe('txt');
    expect(isIPv6('::1')).toBe(true);
    expect(isIPv6('::ffff:192.0.2.1')).toBe(true);
    expect(isIPv6('1:2:3:4:5:6:7:8:9')).toBe(false);
  });

  it('ràng buộc chéo: MX cần priority, proxy chỉ A/AAAA/CNAME, không CNAME ở gốc, TTL', () => {
    expect(err({})).toEqual({});
    expect(err({ type: 'MX', content: 'mail.anphat.vn' })).toEqual({
      priority: 'admin:dns.errors.priority',
    });
    expect(err({ type: 'TXT', content: 'v=spf1 -all', proxied: true })).toEqual({
      proxied: 'admin:dns.errors.proxied',
    });
    expect(err({ type: 'CNAME', content: 'anphat.vn' })).toEqual({
      name: 'admin:dns.errors.cnameApex',
    });
    expect(err({ ttl: 30 })).toEqual({ ttl: 'admin:dns.errors.ttl' });
    // Contract DnsRecordInput: TTL 60–86400 (Cloudflare "auto" không có trong contract).
    expect(err({ ttl: 1 })).toEqual({ ttl: 'admin:dns.errors.ttl' });
    expect(err({ ttl: 60 })).toEqual({});
    expect(err({ name: 'a b' })).toEqual({ name: 'admin:dns.errors.name' });
    expect(err({ name: '_dmarc' })).toEqual({});
    expect(err({ name: '*.dev' })).toEqual({});
  });
});

describe('DNS: provider và zone (Prompt 5.5)', () => {
  it('token Cloudflare đúng dạng; tên bắt buộc', () => {
    expect(dnsProviderSchema.safeParse({ name: 'CF', api_token: 'a'.repeat(40) }).success).toBe(
      true,
    );
    const bad = dnsProviderSchema.safeParse({ name: ' ', api_token: 'có dấu cách nè 123456789' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.message).sort()).toEqual([
      'admin:dns.errors.token',
      'form.required',
    ]);
  });
  it('zone: tên chữ thường, account hệ thống → null', () => {
    const v = { provider_uuid: 'p', name: ' AnPhat.VN ', hosting_account_uuid: NO_ACCOUNT };
    expect(dnsZoneSchema.safeParse(v).success).toBe(true);
    expect(dnsZoneBody(v)).toEqual({
      provider_uuid: 'p',
      name: 'anphat.vn',
      hosting_account_uuid: null,
    });
    expect(dnsZoneBody({ ...v, hosting_account_uuid: 'acc' }).hosting_account_uuid).toBe('acc');
    expect(dnsZoneSchema.safeParse({ ...v, provider_uuid: '' }).error?.issues[0]?.message).toBe(
      'admin:dns.errors.provider',
    );
  });
});
