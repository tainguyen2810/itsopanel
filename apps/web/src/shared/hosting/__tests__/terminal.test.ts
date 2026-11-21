import { describe, expect, it } from 'vitest';
import { closeKind, resizeMessage, terminalUrl } from '../terminal';

describe('terminal', () => {
  it('terminalUrl thêm ticket, đổi http(s) → ws(s), giữ đường dẫn', () => {
    const t = 'A'.repeat(43);
    expect(terminalUrl('wss://panel.itso.local/gateway/terminal', t)).toBe(
      `wss://panel.itso.local/gateway/terminal?ticket=${t}`,
    );
    expect(terminalUrl('https://p.local:28443/gateway/terminal', t)).toBe(
      `wss://p.local:28443/gateway/terminal?ticket=${t}`,
    );
    expect(terminalUrl('/gateway/terminal', 'x-y_z')).toMatch(
      /^ws:\/\/localhost(:\d+)?\/gateway\/terminal\?ticket=x-y_z$/,
    );
  });

  it('resizeMessage kẹp kích thước vào miền agent nhận', () => {
    expect(JSON.parse(resizeMessage(132, 40))).toEqual({ type: 'resize', cols: 132, rows: 40 });
    expect(JSON.parse(resizeMessage(3, 900))).toEqual({ type: 'resize', cols: 20, rows: 200 });
  });

  it('closeKind theo mã của gateway', () => {
    expect(closeKind(4403, 'ticket_invalid')).toBe('ticket');
    expect(closeKind(4410, 'ticket_expired')).toBe('ticketExpired');
    expect(closeKind(4408, 'idle')).toBe('idle');
    expect(closeKind(1000, 'expired')).toBe('expired');
    expect(closeKind(1000, 'exited')).toBe('exited');
    expect(closeKind(1011, 'agent_unavailable')).toBe('unavailable');
    expect(closeKind(1000, 'closed')).toBe('closed');
  });
});
