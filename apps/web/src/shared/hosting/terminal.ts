/** Terminal USER qua itso-gateway (D-75): URL WebSocket, khung resize, ý nghĩa mã đóng. */

/** URL WebSocket kèm ticket (ws_url do panel trả; ticket dùng một lần, 30 giây). */
export function terminalUrl(wsUrl: string, ticket: string): string {
  const u = new URL(wsUrl, typeof location === 'undefined' ? 'http://localhost' : location.href);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  if (u.protocol === 'https:') u.protocol = 'wss:';
  u.searchParams.set('ticket', ticket);
  return u.toString();
}

/** Khung điều khiển resize gửi dạng text JSON. */
export function resizeMessage(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols: clamp(cols, 20, 500), rows: clamp(rows, 5, 200) });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

export type CloseKind =
  'exited' | 'idle' | 'expired' | 'ticket' | 'ticketExpired' | 'unavailable' | 'closed';

/** Phân loại lý do đóng từ mã + reason của gateway (4403/4410/4408, 1000 kèm reason, 1011). */
export function closeKind(code: number, reason: string): CloseKind {
  if (code === 4403) return 'ticket';
  if (code === 4410) return 'ticketExpired';
  if (code === 4408 || reason === 'idle') return 'idle';
  if (reason === 'expired') return 'expired';
  if (code === 1011 || code === 1006) return 'unavailable';
  if (reason === 'exited') return 'exited';
  return 'closed';
}
