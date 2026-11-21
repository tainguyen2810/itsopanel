import { z } from 'zod';

/**
 * Safe-apply tường lửa (docs/planning/03-MODULES.md, 06-AGENT-SECURITY.md): áp dụng xong phải xác nhận trong thời hạn,
 * nếu không agent tự hoàn tác về bộ rule cũ (phòng tự khóa mình khỏi server).
 */
export type SafeApply =
  | { phase: 'idle' }
  | { phase: 'applying'; jobUuid: string; seconds: number }
  | { phase: 'awaiting'; deadline: number }
  | { phase: 'confirming' }
  | { phase: 'confirmed' }
  | { phase: 'rolledBack' };

export type SafeApplyEvent =
  | { type: 'applied'; jobUuid: string; seconds: number }
  | { type: 'jobDone'; now: number }
  | { type: 'jobFailed' }
  | { type: 'tick'; now: number }
  | { type: 'confirm' }
  | { type: 'confirmed' }
  | { type: 'resume'; deadline: number; now: number }
  | { type: 'reset' };

export function safeApplyReducer(s: SafeApply, e: SafeApplyEvent): SafeApply {
  switch (e.type) {
    case 'applied':
      return { phase: 'applying', jobUuid: e.jobUuid, seconds: e.seconds };
    case 'jobDone':
      return s.phase === 'applying' ? { phase: 'awaiting', deadline: e.now + s.seconds * 1000 } : s;
    case 'jobFailed':
      return s.phase === 'applying' ? { phase: 'idle' } : s;
    case 'tick':
      return s.phase === 'awaiting' && e.now >= s.deadline ? { phase: 'rolledBack' } : s;
    case 'confirm':
      return s.phase === 'awaiting' ? { phase: 'confirming' } : s;
    case 'confirmed':
      return s.phase === 'confirming' ? { phase: 'confirmed' } : s;
    case 'resume':
      // Tải lại trang khi agent còn chờ xác nhận (GET …/status = pending_confirm): tiếp tục đếm ngược theo hạn thật.
      return s.phase === 'idle' && e.deadline > e.now
        ? { phase: 'awaiting', deadline: e.deadline }
        : s;
    case 'reset':
      return { phase: 'idle' };
  }
}

/** Số giây còn lại trước khi tự hoàn tác (làm tròn lên, không âm). */
export function secondsLeft(s: SafeApply, now: number): number {
  return s.phase === 'awaiting' ? Math.max(0, Math.ceil((s.deadline - now) / 1000)) : 0;
}

/** "1:05" */
export function mmss(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

const IPV4 = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(\/(3[0-2]|[12]?\d))?$/;
const IPV6 = /^[0-9a-f:]+(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/i;
const PORTS = /^([0-9]{1,5}(-[0-9]{1,5})?)(,[0-9]{1,5}(-[0-9]{1,5})?)*$/;

/** Mọi cổng/khoảng cổng trong 1–65535 và đầu ≤ cuối. */
export function validPorts(p: string): boolean {
  if (!PORTS.test(p)) return false;
  return p.split(',').every((part) => {
    const [a, b = a] = part.split('-').map(Number) as [number, number?];
    return a >= 1 && (b ?? a) <= 65535 && a <= (b ?? a);
  });
}

/** Form thêm rule (FirewallRuleInput); thông báo lỗi là key i18n. */
export const ruleSchema = z
  .object({
    priority: z
      .number('form.invalid')
      .int()
      .min(1, 'admin:firewall.errors.priority')
      .max(9999, 'admin:firewall.errors.priority'),
    action: z.enum(['accept', 'drop', 'reject']),
    direction: z.enum(['in', 'out']),
    protocol: z.enum(['tcp', 'udp', 'icmp', 'any']),
    ports: z.string(),
    source: z.string().refine((v) => IPV4.test(v) || IPV6.test(v), 'admin:firewall.errors.source'),
    comment: z.string().max(200, 'form.invalid'),
  })
  .superRefine((v, ctx) => {
    const needs = v.protocol === 'tcp' || v.protocol === 'udp';
    if (needs && !validPorts(v.ports)) {
      ctx.addIssue({ code: 'custom', path: ['ports'], message: 'admin:firewall.errors.ports' });
    }
  });
export type RuleForm = z.infer<typeof ruleSchema>;

/** Body gửi API: bỏ ports khi icmp/any không có cổng, bỏ comment rỗng. */
export function toRuleInput(v: RuleForm) {
  const ports = v.protocol === 'tcp' || v.protocol === 'udp' ? v.ports : v.ports || undefined;
  return {
    priority: v.priority,
    action: v.action,
    direction: v.direction,
    protocol: v.protocol,
    source: v.source,
    ...(ports ? { ports } : {}),
    ...(v.comment ? { comment: v.comment } : {}),
  };
}
