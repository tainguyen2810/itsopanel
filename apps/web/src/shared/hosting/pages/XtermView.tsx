import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@/ui/Alert';
import { closeKind, resizeMessage, terminalUrl, type CloseKind } from '../terminal';

/** Màu terminal lấy từ token CSS (không dùng màu cứng). */
function tokenTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const map: Record<string, string> = {
    background: '--color-surface-2',
    foreground: '--color-fg',
    cursor: '--color-primary',
    selectionBackground: '--color-primary-soft',
    red: '--color-danger',
    green: '--color-success',
    yellow: '--color-warning',
    blue: '--color-info',
  };
  const out: Record<string, string> = {};
  for (const [k, name] of Object.entries(map)) {
    const v = css.getPropertyValue(name).trim();
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Terminal thật (xterm.js) nối WebSocket tới itso-gateway bằng ticket một lần. Byte bàn phím gửi dạng nhị phân,
 * resize gửi text JSON; lý do đóng (nhàn rỗi, hết hạn, ticket) hiện bằng thông báo dễ hiểu.
 */
export function XtermView({ wsUrl, ticket }: { wsUrl: string; ticket: string }) {
  const { t } = useTranslation('admin');
  const box = useRef<HTMLDivElement>(null);
  const [ended, setEnded] = useState<CloseKind | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !box.current) return;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        scrollback: 5000,
        theme: tokenTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(box.current);
      fit.fit();
      const ws = new WebSocket(terminalUrl(wsUrl, ticket));
      ws.binaryType = 'arraybuffer';
      const enc = new TextEncoder();
      ws.onopen = () => {
        setConnected(true);
        ws.send(resizeMessage(term.cols, term.rows));
        term.focus();
      };
      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) term.write(new Uint8Array(ev.data));
        else if (typeof ev.data === 'string') term.write(ev.data);
      };
      ws.onclose = (ev) => {
        const k = closeKind(ev.code, ev.reason);
        setConnected(false);
        setEnded(k);
      };
      const data = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(enc.encode(d)));
      const resized = term.onResize(
        ({ cols, rows }) => ws.readyState === WebSocket.OPEN && ws.send(resizeMessage(cols, rows)),
      );
      const ro = new ResizeObserver(() => fit.fit());
      ro.observe(box.current);
      cleanup = () => {
        ro.disconnect();
        data.dispose();
        resized.dispose();
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
          ws.close(1000, 'closed');
        term.dispose();
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [wsUrl, ticket]);

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={box}
        role="application"
        aria-label={t('terminal.output')}
        aria-busy={!connected && ended === null}
        className="h-[28rem] overflow-hidden rounded-md border border-border bg-surface-2 p-2"
      />
      {ended !== null && (
        <Alert
          tone={ended === 'exited' || ended === 'closed' ? 'info' : 'warning'}
          title={t(`terminal.ended.${ended}`)}
        >
          {t('terminal.endedHint')}
        </Alert>
      )}
    </div>
  );
}
