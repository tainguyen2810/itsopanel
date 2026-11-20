import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';

/** Vé mở terminal (TerminalTicket) — WebSocket thật nối ở Phase 6. */
export interface Ticket {
  ticket: string;
  ws_url: string;
  expires_at: string;
  mode: 'account' | 'root';
  unix_user: string;
}

/** Phản hồi của terminal mô phỏng: bản demo không bao giờ chạy lệnh. */
export function simulate(cmd: string, user: string, host: string): string[] {
  const c = cmd.trim();
  if (c === '') return [];
  if (c === 'whoami') return [user];
  if (c === 'hostname') return [host];
  if (c === 'clear') return ['\f'];
  return [`demo: "${c}" không được chạy — bản demo chỉ mô phỏng giao diện terminal.`];
}

/** Khung terminal mô phỏng (Admin: theo server; Portal: account của mình). */
export function TerminalView({
  ticket,
  host,
  onClose,
}: {
  ticket: Ticket;
  host: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const prompt = `${ticket.unix_user}@${host}:${ticket.mode === 'root' ? '~#' : '~$'}`;
  const [lines, setLines] = useState<string[]>([t('terminal.banner'), '']);
  const [cmd, setCmd] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const out = simulate(cmd, ticket.unix_user, host);
    setLines((l) => (out[0] === '\f' ? [] : [...l, `${prompt} ${cmd}`, ...out]));
    setCmd('');
    requestAnimationFrame(() => end.current?.scrollIntoView({ block: 'nearest' }));
  };
  return (
    <Card>
      <CardHeader
        title={t('terminal.session', { user: ticket.unix_user, host })}
        description={t('terminal.ticket', { ticket: ticket.ticket })}
        action={
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('terminal.disconnect')}
          </Button>
        }
      />
      <CardContent>
        <div
          role="log"
          aria-label={t('terminal.output')}
          className="h-80 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-sm text-fg"
        >
          {lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap wrap-anywhere">
              {l || ' '}
            </div>
          ))}
          <div ref={end} />
        </div>
        <form onSubmit={submit} className="mt-2 flex items-center gap-2">
          <Label htmlFor="term-input" className="shrink-0 font-mono text-sm">
            {prompt}
          </Label>
          <Input
            id="term-input"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </form>
      </CardContent>
    </Card>
  );
}
