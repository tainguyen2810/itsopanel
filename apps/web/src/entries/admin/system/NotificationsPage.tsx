import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BellOff, CheckCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
import { Tabs, TabsList, TabsTrigger } from '@/ui/Tabs';
import { get, list, send, type Data, type Row } from '../api';
import { useAction } from '../useAction';
import { cn } from '@/shared/lib/utils';

type Note = Row<'/api/v1/admin/notifications'>;
type Prefs = Data<'/api/v1/admin/notification-preferences'>;
const CHANNELS = ['email', 'telegram', 'in_app'] as const;
const EVENTS = [
  'backup.failed',
  'certificate.expiring',
  'security.high',
  'job.failed',
  'alert.firing',
] as const;

/** Đường dẫn trong thông báo là đường dẫn của Admin Panel (không có tiền tố /admin). */
const adminHref = (link: string) => (link.startsWith('/admin') ? link : `/admin${link}`);

export default function NotificationsPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const q = useQuery({
    queryKey: ['admin', 'notifications'],
    queryFn: () => list('/api/v1/admin/notifications'),
  });
  const read = useAction(
    (n: Note) => send('POST', '/api/v1/admin/notifications/{id}:read', { path: { id: n.uuid } }),
    { invalidate: [['admin', 'notifications']] },
  );
  const readAll = useAction(() => send('POST', '/api/v1/admin/notifications:read-all'), {
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
              <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
                <TabsList>
                  <TabsTrigger value="all">{t('notif.all')}</TabsTrigger>
                  <TabsTrigger value="unread">{t('notif.onlyUnread')}</TabsTrigger>
                </TabsList>
              </Tabs>
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
                          href={adminHref(n.link)}
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
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => read.mutate(n)}
                      aria-label={t('notif.markRead', { title: n.title })}
                    >
                      {t('notif.read')}
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
    queryFn: () => get('/api/v1/admin/notification-preferences'),
  });
  if (!q.data)
    return (
      <Card>
        <CardContent className="pt-4">
          <TableSkeleton rows={3} />
        </CardContent>
      </Card>
    );
  // key theo updated_at: lưu xong nạp lại bản mới từ server.
  return <PreferencesForm key={q.data.updated_at} initial={q.data} />;
}

function PreferencesForm({ initial }: { initial: Prefs }) {
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<Prefs>(() => structuredClone(initial));
  const save = useAction(
    (p: Prefs) =>
      send('PATCH', '/api/v1/admin/notification-preferences', {
        body: p,
        headers: { 'If-Match': `"${p.updated_at}"` },
      }),
    { success: t('notif.prefsSaved'), invalidate: [['admin', 'notification-prefs']] },
  );
  const toggleEvent = (e: string, c: (typeof CHANNELS)[number], on: boolean) =>
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
          {CHANNELS.map((c) => (
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
                {CHANNELS.map((c) => (
                  <th key={c} scope="col" className="px-2 py-1 font-medium">
                    {t(`alerts.channel.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EVENTS.map((e) => (
                <tr key={e} className="border-b border-border">
                  <th scope="row" className="py-2 pr-2 text-left font-normal">
                    {t(`notif.ev.${e}`)}
                  </th>
                  {CHANNELS.map((c) => (
                    <td key={c} className="px-2 py-2 text-center">
                      <Checkbox
                        checked={(draft.events[e] ?? []).includes(c)}
                        disabled={draft.channels[c] !== true}
                        onCheckedChange={(v) => toggleEvent(e, c, v === true)}
                        aria-label={t('notif.eventChannel', {
                          event: t(`notif.ev.${e}`),
                          channel: t(`alerts.channel.${c}`),
                        })}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
