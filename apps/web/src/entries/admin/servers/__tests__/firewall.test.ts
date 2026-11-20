import { describe, expect, it } from 'vitest';
import {
  mmss,
  ruleSchema,
  safeApplyReducer,
  secondsLeft,
  toRuleInput,
  validPorts,
  type SafeApply,
} from '../firewall';
import { enrollSchema } from '../ServerNewPage';
import { nginxSchema } from '../ServerNginxPage';
import { softwareActions } from '../ServerSoftwarePage';
import { simulate } from '../ServerTerminalPage';

describe('safe-apply tường lửa: đếm ngược và tự hoàn tác', () => {
  const t0 = 1_000_000;
  const run = (events: Parameters<typeof safeApplyReducer>[1][]) =>
    events.reduce<SafeApply>(safeApplyReducer, { phase: 'idle' });

  it('đếm ngược bắt đầu khi job áp dụng xong, không phải lúc bấm', () => {
    const s = run([{ type: 'applied', jobUuid: 'j', seconds: 60 }]);
    expect(s.phase).toBe('applying');
    expect(secondsLeft(s, t0)).toBe(0);
    const a = safeApplyReducer(s, { type: 'jobDone', now: t0 });
    expect(a).toEqual({ phase: 'awaiting', deadline: t0 + 60_000 });
    expect(secondsLeft(a, t0)).toBe(60);
    expect(secondsLeft(a, t0 + 59_001)).toBe(1);
    expect(mmss(secondsLeft(a, t0 + 4_500))).toBe('0:56');
  });

  it('hết hạn mà chưa xác nhận → rolledBack; còn hạn thì giữ nguyên', () => {
    const a = run([
      { type: 'applied', jobUuid: 'j', seconds: 30 },
      { type: 'jobDone', now: t0 },
    ]);
    expect(safeApplyReducer(a, { type: 'tick', now: t0 + 29_999 }).phase).toBe('awaiting');
    expect(safeApplyReducer(a, { type: 'tick', now: t0 + 30_000 }).phase).toBe('rolledBack');
  });

  it('xác nhận trong hạn → confirmed; tick sau đó không hoàn tác', () => {
    const s = run([
      { type: 'applied', jobUuid: 'j', seconds: 30 },
      { type: 'jobDone', now: t0 },
      { type: 'confirm' },
      { type: 'tick', now: t0 + 60_000 },
      { type: 'confirmed' },
    ]);
    expect(s.phase).toBe('confirmed');
  });

  it('job áp dụng thất bại → quay về idle (máy chủ giữ rule cũ)', () => {
    expect(run([{ type: 'applied', jobUuid: 'j', seconds: 30 }, { type: 'jobFailed' }])).toEqual({
      phase: 'idle',
    });
  });
});

describe('form rule tường lửa', () => {
  const base = {
    priority: 100,
    action: 'accept' as const,
    direction: 'in' as const,
    protocol: 'tcp' as const,
    ports: '80,443',
    source: '10.10.0.0/16',
    comment: '',
  };
  const err = (v: object) =>
    ruleSchema
      .safeParse({ ...base, ...v })
      .error?.issues.map((i) => `${String(i.path[0])}:${i.message}`);

  it('hợp lệ và body gửi API bỏ trường rỗng', () => {
    expect(err({})).toBeUndefined();
    expect(toRuleInput({ ...base })).toEqual({
      priority: 100,
      action: 'accept',
      direction: 'in',
      protocol: 'tcp',
      ports: '80,443',
      source: '10.10.0.0/16',
    });
  });

  it('TCP/UDP bắt buộc cổng hợp lệ; ICMP không cần cổng', () => {
    expect(err({ ports: '' })).toEqual(['ports:admin:firewall.errors.ports']);
    expect(err({ ports: '70000' })).toEqual(['ports:admin:firewall.errors.ports']);
    expect(err({ ports: '9000-8000' })).toEqual(['ports:admin:firewall.errors.ports']);
    expect(err({ protocol: 'icmp', ports: '' })).toBeUndefined();
    expect(validPorts('22,8000-8100')).toBe(true);
  });

  it('nguồn phải là IP/CIDR, ưu tiên 1–9999', () => {
    expect(err({ source: '10.10.0.0/33' })).toEqual(['source:admin:firewall.errors.source']);
    expect(err({ source: 'any' })).toEqual(['source:admin:firewall.errors.source']);
    expect(err({ source: '2001:db8::/32' })).toBeUndefined();
    expect(err({ priority: 0 })).toEqual(['priority:admin:firewall.errors.priority']);
  });
});

describe('form khác của trang server', () => {
  it('token thêm server: tên, vai trò, thời hạn', () => {
    expect(
      enrollSchema.safeParse({ name: 'srv-hn-03', role_tags: ['web'], ttl_min: 60 }).success,
    ).toBe(true);
    const bad = enrollSchema.safeParse({ name: 'Srv 03', role_tags: [], ttl_min: 2 });
    expect(bad.error?.issues.map((i) => i.path[0])).toEqual(['name', 'role_tags', 'ttl_min']);
  });

  it('Nginx: worker_processes auto|số, connections 256–65535, kích thước k/m/g', () => {
    const ok = {
      worker_processes: 'auto',
      worker_connections: 4096,
      client_max_body_size: '64m',
      gzip: true,
      http2: true,
      server_tokens: false,
    };
    expect(nginxSchema.safeParse(ok).success).toBe(true);
    const bad = nginxSchema.safeParse({
      ...ok,
      worker_processes: 'many',
      worker_connections: 10,
      client_max_body_size: '64mb',
    });
    expect(bad.error?.issues.map((i) => i.path[0])).toEqual([
      'worker_processes',
      'worker_connections',
      'client_max_body_size',
    ]);
  });

  it('phần mềm: hành động theo trạng thái', () => {
    expect(softwareActions({ state: 'available' })).toEqual(['install']);
    expect(softwareActions({ state: 'upgradable' })).toEqual(['upgrade', 'remove']);
    expect(softwareActions({ state: 'installing' })).toEqual([]);
  });

  it('terminal mô phỏng không chạy lệnh', () => {
    expect(simulate('whoami', 'anphat', 'srv-hn-01')).toEqual(['anphat']);
    expect(simulate('rm -rf /', 'root', 'srv-hn-01')[0]).toMatch(/không được chạy/);
  });
});
