import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play, PlayCircle, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { ListPage } from '@/shared/page/ListPage';
import { Badge, StatusBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import type { ColumnDef } from '@/ui/DataTable';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { ProgressBar } from '@/ui/ProgressBar';
import { Alert } from '@/ui/Alert';
import { ErrorState } from '@/shared/page/states';
import { get, list, type Row } from '../api';
import { SecurityNav } from './common';

type Session = Row<'/api/v1/admin/terminal/sessions'>;
type Event = { t: number; data: string };

/** Bỏ mã điều khiển ANSI (màu, di chuyển con trỏ) để hiện bản ghi dạng chữ thường. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, '').replace(/\r/g, '');
}

/** Nội dung màn hình sau thời điểm `at` (giây) của bản ghi. */
export function screenAt(events: Event[], at: number): string {
  return stripAnsi(
    events
      .filter((e) => e.t <= at)
      .map((e) => e.data)
      .join(''),
  );
}

type Page = {
  width: number;
  height: number;
  events: Event[];
  next_offset: number | null;
  truncated: boolean;
};

/** Số trang tối đa tải cho một lần phát lại (mỗi trang ≤ 256 KB từ agent → ~10 MB). */
export const MAX_PAGES = 40;

/**
 * Tải bản ghi theo trang (pty.recording.read qua API): đọc nối tiếp theo next_offset tới khi null; quá MAX_PAGES
 * thì dừng và đánh dấu `partial` (phát phần đầu, tránh treo trình duyệt với bản ghi 50 MB).
 */
export async function loadRecording(fetchPage: (offset: number) => Promise<Page>): Promise<{
  width: number;
  height: number;
  events: Event[];
  truncated: boolean;
  partial: boolean;
}> {
  let offset = 0;
  const events: Event[] = [];
  let first: Page | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const p = await fetchPage(offset);
    first ??= p;
    events.push(...p.events);
    if (p.next_offset === null)
      return {
        width: first.width,
        height: first.height,
        events,
        truncated: p.truncated,
        partial: false,
      };
    if (p.next_offset <= offset) break; // phòng vòng lặp nếu API trả offset không tiến
    offset = p.next_offset;
  }
  return {
    width: first?.width ?? 80,
    height: first?.height ?? 24,
    events,
    truncated: false,
    partial: true,
  };
}

/** Phiên terminal (D-81): ai mở, khi nào, root hay account; phiên được ghi xem lại được (cần step-up). */
export default function TerminalSessionsPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [playing, setPlaying] = useState<Session | null>(null);
  const columns: ColumnDef<Session, unknown>[] = [
    {
      id: 'user',
      header: t('terminal.unixUser'),
      accessorKey: 'unix_user',
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-mono text-sm">
            {row.original.unix_user}@{row.original.server.name}
          </span>
          <span className="text-sm text-muted">
            {row.original.hosting_account?.username ?? '—'}
          </span>
        </div>
      ),
    },
    {
      id: 'mode',
      header: t('terminal.mode'),
      accessorKey: 'mode',
      cell: ({ row }) => (
        <Badge tone={row.original.mode === 'root' ? 'danger' : 'neutral'}>
          {t(`terminal.modes.${row.original.mode}`)}
        </Badge>
      ),
    },
    {
      id: 'opened_by',
      header: t('terminal.openedBy'),
      accessorFn: (r) => r.opened_by.name,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span>{row.original.opened_by.name}</span>
          <span className="font-mono text-sm text-muted">{row.original.client_ip ?? '—'}</span>
        </div>
      ),
    },
    {
      id: 'started_at',
      header: t('terminal.startedAt'),
      accessorKey: 'started_at',
      cell: ({ row }) => fmt.rel(row.original.started_at),
    },
    {
      id: 'state',
      header: t('servers.status'),
      accessorFn: (r) => (r.ended_at ? (r.ended_reason ?? 'closed') : 'open'),
      cell: ({ row }) =>
        row.original.ended_at ? (
          <span className="text-sm text-muted">
            {t(`terminal.endedReason.${row.original.ended_reason ?? 'closed'}`)}
          </span>
        ) : (
          <StatusBadge status="active" />
        ),
    },
    {
      id: 'recording',
      header: t('terminal.recordingCol'),
      enableSorting: false,
      cell: ({ row }) =>
        row.original.recorded ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPlaying(row.original)}
            disabled={!row.original.ended_at}
          >
            <PlayCircle aria-hidden />
            {t('terminal.play')}
          </Button>
        ) : (
          <span className="text-sm text-muted">{t('terminal.notRecorded')}</span>
        ),
    },
  ];
  return (
    <>
      <ListPage<Session>
        title={t('terminal.sessionsTitle')}
        description={t('terminal.sessionsDescription')}
        nav={<SecurityNav current="terminal" />}
        queryKey={['admin', 'terminal', 'sessions']}
        fetch={(q) => list('/api/v1/admin/terminal/sessions', q)}
        columns={columns}
        getRowId={(s) => s.uuid}
        primaryColumnId="user"
      />
      <Player key={playing?.uuid ?? 'none'} session={playing} onClose={() => setPlaying(null)} />
    </>
  );
}

function Player({ session, onClose }: { session: Session | null; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [ready, setReady] = useState(false);
  // Xem bản ghi phiên là thao tác nhạy cảm: step-up qua hộp thoại chung (403 mfa_step_up_required).
  const rec = useQuery({
    queryKey: ['admin', 'terminal', 'recording', session?.uuid],
    enabled: session !== null,
    queryFn: async () => {
      const r = await loadRecording((offset) =>
        get('/api/v1/admin/terminal/sessions/{id}/recording', {
          path: { id: session?.uuid ?? '' },
          query: { offset },
        }),
      );
      setReady(true);
      return r;
    },
  });
  const events = useMemo(() => rec.data?.events ?? [], [rec.data]);
  const total = events.at(-1)?.t ?? 0;
  const [at, setAt] = useState(Number.POSITIVE_INFINITY);
  const [run, setRun] = useState(false);
  useEffect(() => {
    if (!run) return;
    const start = performance.now() - Math.min(at, total) * 1000;
    const h = setInterval(() => {
      const now = (performance.now() - start) / 1000;
      setAt(now);
      if (now >= total) setRun(false);
    }, 100);
    return () => clearInterval(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, total]);
  const shown = Math.min(at, total);
  return (
    <Dialog open={session !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('terminal.playTitle', {
          user: session?.unix_user ?? '',
          host: session?.server.name ?? '',
        })}
        description={session ? fmt.dateTime(session.started_at) : ''}
        className="max-w-3xl"
      >
        <div className="flex flex-col gap-3">
          <pre
            role="log"
            aria-label={t('terminal.output')}
            className="h-72 overflow-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-sm whitespace-pre-wrap text-fg"
          >
            {ready ? screenAt(events, shown) : t('terminal.loadingRecording')}
          </pre>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-label={run ? t('terminal.pause') : t('terminal.play')}
              onClick={() => {
                if (!run && shown >= total) setAt(0);
                setRun((r) => !r);
              }}
              disabled={!ready}
            >
              {run ? <Pause aria-hidden /> : <Play aria-hidden />}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('terminal.restart')}
              onClick={() => {
                setAt(0);
                setRun(true);
              }}
              disabled={!ready}
            >
              <RotateCcw aria-hidden />
            </Button>
            <ProgressBar
              value={total ? (shown / total) * 100 : 0}
              label={t('terminal.progress')}
              className="flex-1"
            />
            <span className="font-mono text-sm text-muted tabular-nums">
              {shown.toFixed(1)}s / {total.toFixed(1)}s
            </span>
          </div>
          {rec.data?.truncated && <Alert tone="warning" title={t('terminal.truncated')} />}
          {rec.data?.partial && <Alert tone="info" title={t('terminal.partial')} />}
          {rec.error && <ErrorState error={rec.error} onRetry={() => void rec.refetch()} />}
          {session && (
            <p className="text-sm text-muted">
              {t('terminal.recordingMeta', {
                size: fmt.bytes(session.recording_bytes),
                by: session.opened_by.name,
                ip: session.client_ip ?? '—',
              })}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
