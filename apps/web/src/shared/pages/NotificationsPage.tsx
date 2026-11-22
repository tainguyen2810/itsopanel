import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellOff, CheckCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useRoutesInfo } from '@/shared/routing/RoutesContext';
import { useFmt } from '@/shared/format/useFmt';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { AppLink } from '@/ui/AppLink';
import { Badge, SeverityBadge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent, CardHeader } from '@/ui/Card';
import { Checkbox, Switch } from '@/ui/Checkbox';
import { EmptyState } from '@/ui/Feedback';
import { Label } from '@/ui/Label';
import { get, list, send, type Data, type Row } from '@/shared/api/realm';
import { useAction } from '@/shared/api/useAction';
import { cn } from '@/shared/lib/utils';

type Note = Row<'/notifications'>;
type Prefs = Data<'/notification-preferences'>;
type Event = Row<'/notification-events'>;
type Channel = 'email' | 'telegram' | 'in_app';
const CHANNELS: Channel[] = ['in_app', 'email', 'telegram'];

/** Đường dẫn trong thông báo không kèm tiền tố realm (`/websites/…`): ghép với basepath. */
const linkHref = (base: string, link: string) =>
  link.startsWith('/admin/') || link.startsWith('/portal/') ? link : `${base}${link}`;

export default function NotificationsPage() {
  const { t } = useTranslation('admin');
  const { basepath } = useRoutesInfo();
  const fmt = useFmt();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const q = useQuery({
    queryKey: ['admin', 'notifications'],
    queryFn: () => list('/notifications'),
  });
  const read = useAction(
    (n: Note) => send('POST', '/notifications/{id}:read', { path: { id: n.uuid } }),
    { invalidate: [['admin', 'notifications']] },
  );
  const readAll = useAction(() => send('POST', '/notifications:read-all'), {
    success: t('notif.allRead'),
    invalidate: [['admin', 'notifications']],
  });
  const rows = (q.data ?? []).filter((n) => filter === 'all' || n.read_at === null);
  const unread = (q.data ?? []).filter((n) => n.read_at === null).length;
  return (
    <>
      <PageHeader
        title={t('notif.title')}
        description={t('notif.description')}
        meta={
          unread > 0 ? (
            <Badge tone="primary">{t('notif.unread', { count: unread })}</Badge>
          ) : undefined
        }
        actions={
          <Button
            variant="outline"
            onClick={() => readAll.mutate()}
            disabled={unread === 0 || readAll.isPending}
          >
            <CheckCheck aria-hidden />
            {t('notif.readAll')}
          </Button>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <Card>
          <CardHeader
            title={t('notif.inbox')}
            action={
              // Bộ lọc (không phải tab: không có panel riêng) → nhóm nút bật/tắt aria-pressed.
              <div
                role="group"
                aria-label={t('notif.inbox')}
                className="inline-flex rounded-md border border-border p-0.5"
              >
                {(['all', 'unread'] as const).map((f) => (
                  <Button
                    key={f}
                    size="sm"
                    variant={filter === f ? 'secondary' : 'ghost'}
                    aria-pressed={filter === f}
                    onClick={() => setFilter(f)}
                  >
                    {f === 'all' ? t('notif.all') : t('notif.onlyUnread')}
                  </Button>
                ))}
              </div>
            }
          />
          <CardContent>
            {q.isLoading && <TableSkeleton rows={4} />}
            {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
            {q.data && rows.length === 0 && <EmptyState icon={BellOff} title={t('notif.empty')} />}
            <ul className="divide-y divide-border">
              {rows.map((n) => (
                <li
                  key={n.uuid}
                  className={cn('flex gap-3 py-3', n.read_at === null && 'font-medium')}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-2 size-2 shrink-0 rounded-full',
                      n.read_at === null ? 'bg-primary' : 'bg-transparent',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={n.severity} />
                      {n.link ? (
                        <AppLink
                          href={linkHref(basepath, n.link)}
                          className="wrap-anywhere hover:underline"
                          onClick={() => n.read_at === null && read.mutate(n)}
                        >
                          {n.title}
                        </AppLink>
                      ) : (
                        <span className="wrap-anywhere">{n.title}</span>
                      )}
                      {n.read_at === null && <span className="sr-only">{t('notif.new')}</span>}
                    </div>
                    <p className="text-sm font-normal text-muted">{n.body}</p>
                    <p className="text-xs font-normal text-subtle">{fmt.rel(n.created_at)}</p>
                  </div>
                  {n.read_at === null && (
                    <Button size="sm" variant="ghost" onClick={() => read.mutate(n)}>
                      {t('notif.read')}
                      <span className="sr-only">: {n.title}</span>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <PreferencesCard />
      </div>
    </>
  );
}

function PreferencesCard() {
  const q = useQuery({
    queryKey: ['admin', 'notification-prefs'],
    queryFn: () => get('/notification-preferences'),
  });
  // Danh mục sự kiện theo vai trò (D-104): Portal chỉ thấy sự kiện của USER, kênh in_app + email.
  const ev = useQuery({
    queryKey: ['admin', 'notification-events'],
    queryFn: () => list('/notification-events'),
  });
  if (q.isError || ev.isError)
    return (
      <Card>
        <CardContent className="pt-4">
          <ErrorState
            error={q.error ?? ev.error}
            onRetry={() => void Promise.all([q.refetch(), ev.refetch()])}
          />
        </CardContent>
      </Card>
    );
  if (!q.data || !ev.data)
    return (
      <Card>
        <CardContent className="pt-4">
          <TableSkeleton rows={3} />
        </CardContent>
      </Card>
    );
  // key theo updated_at: lưu xong nạp lại bản mới từ server.
  return <PreferencesForm key={q.data.updated_at} initial={q.data} events={ev.data} />;
}

function PreferencesForm({ initial, events }: { initial: Prefs; events: Event[] }) {
  const { t } = useTranslation('admin');
  const has = (e: Event, c: Channel) => (e.channels as string[]).includes(c);
  const channels = CHANNELS.filter((c) => events.some((e) => has(e, c)));
  const groups = [...new Set(events.map((e) => e.group))];
  const evLabel = (type: string) => t(`events.${type}` as never, { defaultValue: type }) as string;
  const [draft, setDraft] = useState<Prefs>(() => structuredClone(initial));
  const save = useAction(
    (p: Prefs) =>
      send('PATCH', '/notification-preferences', {
        body: p,
        headers: { 'If-Match': `"${p.updated_at}"` },
      }),
    { success: t('notif.prefsSaved'), invalidate: [['admin', 'notification-prefs']] },
  );
  const toggleEvent = (e: string, c: Channel, on: boolean) =>
    setDraft((d) => {
      const cur = d.events[e] ?? [];
      return {
        ...d,
        events: { ...d.events, [e]: on ? [...new Set([...cur, c])] : cur.filter((x) => x !== c) },
      };
    });
  return (
    <Card>
      <CardHeader title={t('notif.prefs')} description={t('notif.prefsHint')} />
      <CardContent className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 font-medium">{t('notif.channels')}</legend>
          {channels.map((c) => (
            <div key={c} className="flex items-center justify-between gap-3">
              <Label htmlFor={`ch-${c}`}>{t(`alerts.channel.${c}`)}</Label>
              <Switch
                id={`ch-${c}`}
                checked={draft.channels[c] === true}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, channels: { ...draft.channels, [c]: v } })
                }
              />
            </div>
          ))}
        </fieldset>
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="mb-2 text-left text-base font-medium">{t('notif.events')}</caption>
            <thead>
              <tr className="border-b border-border text-muted">
                <th scope="col" className="py-1 text-left font-medium">
                  {t('notif.event')}
                </th>
                {channels.map((c) => (
                  <th key={c} scope="col" className="px-2 py-1 font-medium">
                    {t(`alerts.channel.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g}>
                <tr>
                  <th
                    scope="colgroup"
                    colSpan={channels.length + 1}
                    className="pt-3 pb-1 text-left text-xs font-medium tracking-wide text-subtle uppercase"
                  >
                    {t(`notif.groups.${g}` as never, { defaultValue: g }) as string}
                  </th>
                </tr>
                {events
                  .filter((e) => e.group === g)
                  .map((e) => (
                    <tr key={e.type} className="border-b border-border">
                      <th scope="row" className="py-2 pr-2 text-left font-normal">
                        {evLabel(e.type)}
                      </th>
                      {channels.map((c) => {
                        if (!has(e, c))
                          return (
                            <td key={c} className="px-2 py-2 text-center text-subtle">
                              <span aria-hidden>—</span>
                              <span className="sr-only">{t('notif.unavailable')}</span>
                            </td>
                          );
                        const locked = c === 'in_app' && e.in_app_locked;
                        return (
                          <td key={c} className="px-2 py-2 text-center">
                            <Checkbox
                              checked={locked || (draft.events[e.type] ?? []).includes(c)}
                              disabled={locked || draft.channels[c] !== true}
                              onCheckedChange={(v) => toggleEvent(e.type, c, v === true)}
                              aria-label={t('notif.eventChannel', {
                                event: evLabel(e.type),
                                channel: t(`alerts.channel.${c}`),
                              })}
                              {...(locked ? { title: t('notif.locked') } : {})}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </tbody>
            ))}
          </table>
          <p className="mt-2 text-xs text-muted">{t('notif.lockedHint')}</p>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>
            {t('notif.savePrefs')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
