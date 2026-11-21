import { describe, expect, it } from 'vitest';
import { allowlistSchema, ipInCidr, isCidr, splitList, sshSchema } from '../forms';

describe('IP / CIDR', () => {
  it.each([
    ['10.0.0.0/8', true],
    ['203.0.113.7', true],
    ['2001:db8::/32', true],
    ['10.0.0.0/33', false],
    ['256.1.1.1', false],
    ['10.0.0.0/8/1', false],
    ['abc', false],
  ])('isCidr(%s) = %s', (s, ok) => expect(isCidr(s)).toBe(ok));

  it('ipInCidr', () => {
    expect(ipInCidr('10.10.5.20', '10.10.0.0/16')).toBe(true);
    expect(ipInCidr('10.11.5.20', '10.10.0.0/16')).toBe(false);
    expect(ipInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
    expect(ipInCidr('203.0.113.7', '203.0.113.7')).toBe(true);
  });

  it('allowlist: không rỗng, không trùng, CIDR hợp lệ', () => {
    expect(allowlistSchema.safeParse({ entries: [] }).success).toBe(false);
    const dup = allowlistSchema.safeParse({
      entries: [
        { cidr: '10.0.0.0/8', note: '' },
        { cidr: '10.0.0.0/8 ', note: '' },
      ],
    });
    expect(dup.error?.issues[0]?.message).toBe('admin:sec.errors.dup');
    expect(
      allowlistSchema.safeParse({ entries: [{ cidr: '10.0.0.0/8', note: 'VPN' }] }).success,
    ).toBe(true);
  });
});

describe('SSH', () => {
  const ok = {
    port: 22,
    password_authentication: false,
    permit_root_login: 'no' as const,
    allow_groups: 'itso-admin, sftp',
    max_auth_tries: 3,
    rollback_after_sec: 120,
  };
  it('không cho để trống nhóm được SSH (tự khóa mình ra ngoài)', () => {
    expect(sshSchema.safeParse(ok).success).toBe(true);
    expect(sshSchema.safeParse({ ...ok, allow_groups: ' ' }).success).toBe(false);
    expect(sshSchema.safeParse({ ...ok, allow_groups: 'Root;rm' }).success).toBe(false);
    expect(sshSchema.safeParse({ ...ok, port: 70000 }).success).toBe(false);
    expect(splitList('a, b  a\nc')).toEqual(['a', 'b', 'c']);
  });
});
