import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Cpu, Database, Globe, HardDrive, Plus, Server, Trash2, Users } from 'lucide-react';
import demo from '../../../../../contracts/examples/demo-dataset.json';
import tokens from '../../../../../design/tokens/tokens.json';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelative,
} from '@/shared/i18n/format';
import { currentLocale } from '@/shared/i18n';
import { useTheme } from '@/shared/theme/ThemeProvider';
import {
  Alert,
  AreaChart,
  Badge,
  BarChart,
  Breadcrumb,
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogTrigger,
  DonutChart,
  Drawer,
  DrawerContent,
  DrawerTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  FormField,
  Gauge,
  Input,
  JobProgress,
  Kbd,
  Label,
  Pagination,
  ProgressBar,
  Select,
  Separator,
  Skeleton,
  StatCard,
  StatusBadge,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  toast,
  type ColumnDef,
  type StatusKey,
  Avatar,
} from '@/ui';

interface ServerRow {
  name: string;
  status: StatusKey;
  cpu: number;
  ram: number;
  accounts: number;
  spec: number;
  observed: number;
}

const SERVERS: ServerRow[] = demo.servers.map((s) => ({
  name: s.name,
  status: s.status === 'ready' ? 'online' : s.status === 'degraded' ? 'degraded' : 'offline',
  cpu: s.resources.cpu_pct,
  ram: Math.round((s.resources.ram_used_mb / s.resources.ram_mb) * 1000) / 10,
  accounts: s.account_count,
  spec: s.spec_version,
  observed: s.observed_version,
}));

const NETWORK = ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00', '24:00'].map((time, i) => ({
  time,
  in: [120, 90, 260, 410, 380, 520, 300][i] ?? 0,
  out: [80, 60, 140, 220, 260, 310, 180][i] ?? 0,
}));

const COLOR_NAMES = Object.keys(tokens.themes.dark.color);

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`sec-${id}`} className="flex flex-col gap-4">
      <h2 id={`sec-${id}`} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const formSchema = z.object({
  name: z
    .string()
    .min(1, 'form.required')
    .min(3, 'form.minLength|3')
    .regex(/^[a-z0-9-]+$/, 'form.invalid'),
  email: z.email('form.email'),
  php: z.string().min(1, 'form.required'),
  notes: z.string().optional(),
  backup: z.boolean(),
});
type FormValues = z.infer<typeof formSchema>;

function SampleForm() {
  const { t } = useTranslation('design');
  const { control, handleSubmit } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', email: '', php: '8.3', notes: '', backup: true },
  });
  return (
    <form
      noValidate
      onSubmit={handleSubmit(() => toast.success(t('sample.submitted')))}
      className="grid gap-4 sm:grid-cols-2"
    >
      <FormField
        control={control}
        name="name"
        label={t('sample.serverName')}
        description={t('sample.serverHelp')}
        render={(f) => (
          <Input
            {...f}
            value={String(f.value ?? '')}
            onChange={(e) => f.onChange(e.target.value)}
          />
        )}
      />
      <FormField
        control={control}
        name="email"
        label={t('sample.email')}
        render={(f) => (
          <Input
            type="email"
            {...f}
            value={String(f.value ?? '')}
            onChange={(e) => f.onChange(e.target.value)}
          />
        )}
      />
      <FormField
        control={control}
        name="php"
        label={t('sample.php')}
        render={(f) => (
          <Select
            id={f.id}
            aria-invalid={f['aria-invalid']}
            {...(f['aria-describedby'] ? { 'aria-describedby': f['aria-describedby'] } : {})}
            value={String(f.value)}
            onValueChange={f.onChange}
            options={[
              { value: '8.1', label: 'PHP 8.1' },
              { value: '8.2', label: 'PHP 8.2' },
              { value: '8.3', label: 'PHP 8.3' },
              { value: '8.4', label: 'PHP 8.4' },
            ]}
          />
        )}
      />
      <FormField
        control={control}
        name="backup"
        label={t('sample.autoBackup')}
        render={(f) => <Switch id={f.id} checked={f.value === true} onCheckedChange={f.onChange} />}
      />
      <FormField
        className="sm:col-span-2"
        control={control}
        name="notes"
        label={t('sample.notes')}
        optional
        render={(f) => (
          <Textarea
            {...f}
            value={String(f.value ?? '')}
            onChange={(e) => f.onChange(e.target.value)}
          />
        )}
      />
      <div className="flex items-center gap-2 sm:col-span-2">
        <Checkbox id="agree" defaultChecked />
        <Label htmlFor="agree">{t('sample.agree')}</Label>
        <Button type="submit" className="ml-auto">
          {t('sample.submit')}
        </Button>
      </div>
    </form>
  );
}

/** Trang /design/ chỉ dùng khi phát triển: toàn bộ component ở light/dark, VI/EN (thay Storybook). */
export function DesignPage() {
  const { t, i18n } = useTranslation('design');
  const tc = useTranslation('common').t;
  const { resolvedTheme, setTheme } = useTheme();
  const locale = currentLocale(i18n);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [page, setPage] = useState(2);

  const columns: ColumnDef<ServerRow, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('sample.name'),
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      accessorKey: 'status',
      header: t('sample.status'),
      cell: ({ row }) => (
        <StatusBadge
          status={row.original.status}
          desiredVersion={row.original.spec}
          observedVersion={row.original.observed}
        />
      ),
    },
    {
      accessorKey: 'cpu',
      header: t('sample.cpuCol'),
      cell: ({ row }) => (
        <ProgressBar
          className="w-32"
          label={`CPU ${row.original.name}`}
          value={row.original.cpu}
          showValue
          thresholds={{ warn: 70, danger: 90 }}
        />
      ),
    },
    {
      accessorKey: 'ram',
      header: t('sample.ramCol'),
      cell: ({ row }) => (
        <ProgressBar
          className="w-32"
          label={`RAM ${row.original.name}`}
          value={row.original.ram}
          showValue
          thresholds={{ warn: 75, danger: 90 }}
        />
      ),
    },
    {
      accessorKey: 'accounts',
      header: t('sample.accounts'),
      cell: ({ row }) => formatNumber(row.original.accounts, locale),
    },
  ];

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-(--z-topbar) border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-screen-xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{t('title')}</h1>
            <p className="text-sm text-muted">{t('subtitle')}</p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2" role="group" aria-label="Theme / Language">
            <Button
              size="sm"
              variant={resolvedTheme === 'light' ? 'primary' : 'outline'}
              aria-pressed={resolvedTheme === 'light'}
              onClick={() => setTheme('light')}
            >
              Light
            </Button>
            <Button
              size="sm"
              variant={resolvedTheme === 'dark' ? 'primary' : 'outline'}
              aria-pressed={resolvedTheme === 'dark'}
              onClick={() => setTheme('dark')}
            >
              Dark
            </Button>
            <Button
              size="sm"
              variant={locale === 'vi' ? 'primary' : 'outline'}
              aria-pressed={locale === 'vi'}
              onClick={() => void i18n.changeLanguage('vi')}
            >
              VI
            </Button>
            <Button
              size="sm"
              variant={locale === 'en' ? 'primary' : 'outline'}
              aria-pressed={locale === 'en'}
              onClick={() => void i18n.changeLanguage('en')}
            >
              EN
            </Button>
            <Button size="sm" variant="link" asChild>
              <a href="/admin/">/admin</a>
            </Button>
            <Button size="sm" variant="link" asChild>
              <a href="/portal/">/portal</a>
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto flex max-w-screen-xl flex-col gap-10 px-4 py-8 sm:px-6">
        <Section id="tokens" title={t('sections.tokens')}>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {COLOR_NAMES.map((n) => (
              <li
                key={n}
                className="flex items-center gap-2 rounded-md border border-border bg-surface p-2"
              >
                <span
                  aria-hidden
                  className="size-7 shrink-0 rounded-sm border border-border"
                  style={{ background: `var(--itso-${n})` }}
                />
                <code className="truncate font-mono text-xs">{n}</code>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted">
            {formatNumber(1234567.891, locale)} · {formatPercent(0.375, locale)} ·{' '}
            {formatBytes(5_368_709_120, locale)} ·{' '}
            {formatDateTime('2026-11-20T08:15:00+07:00', locale, 'Asia/Ho_Chi_Minh')} ·{' '}
            {formatRelative(
              '2026-11-20T08:12:00+07:00',
              locale,
              new Date('2026-11-20T08:15:00+07:00'),
            )}
          </p>
        </Section>

        <Section id="buttons" title={t('sections.buttons')}>
          <div className="flex flex-wrap items-center gap-2">
            <Button>
              <Plus aria-hidden />
              {tc('actions.create')}
            </Button>
            <Button variant="secondary">{tc('actions.save')}</Button>
            <Button variant="outline">{tc('actions.edit')}</Button>
            <Button variant="ghost">{tc('actions.cancel')}</Button>
            <Button variant="danger">
              <Trash2 aria-hidden />
              {tc('actions.delete')}
            </Button>
            <Button variant="link">{tc('actions.viewAll')}</Button>
            <Button size="sm">sm</Button>
            <Button size="lg">lg</Button>
            <Button size="icon" variant="outline" aria-label={tc('actions.search')}>
              <Globe aria-hidden />
            </Button>
            <Button disabled>{tc('state.loading')}</Button>
            <Kbd>Ctrl K</Kbd>
            <Avatar name="Quản trị hệ thống" />
          </div>
        </Section>

        <Section id="forms" title={t('sections.forms')}>
          <Card>
            <CardContent>
              <SampleForm />
            </CardContent>
          </Card>
        </Section>

        <Section id="status" title={t('sections.status')}>
          <div className="flex flex-wrap gap-2">
            {(
              [
                'active',
                'provisioning',
                'pending',
                'suspended',
                'failed',
                'terminated',
                'online',
                'degraded',
              ] as const
            ).map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
            <StatusBadge status="online" desiredVersion={5} observedVersion={4} />
            <StatusBadge status="online" desiredVersion={3} observedVersion={3} />
            <Badge tone="accent">PHP 8.3</Badge>
            <Badge tone="primary">Let&apos;s Encrypt</Badge>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={t('sample.servers')}
              value="3"
              icon={Server}
              tone="primary"
              delta={{ value: '+1', direction: 'up' }}
            />
            <StatCard
              label={t('sample.websites')}
              value="128"
              icon={Globe}
              tone="success"
              delta={{ value: '+12', direction: 'up' }}
            />
            <StatCard label={t('sample.databases')} value="64" icon={Database} tone="accent" />
            <StatCard
              label={t('sample.users')}
              value="42"
              icon={Users}
              tone="warning"
              delta={{ value: '-2', direction: 'down' }}
            />
          </div>
          <Card>
            <CardContent className="grid grid-cols-2 gap-6 sm:grid-cols-4">
              <Gauge label={t('sample.cpu')} value={37.5} detail="16 vCPU" tone="primary" />
              <Gauge
                label={t('sample.ram')}
                value={42.9}
                detail={`${formatBytes(28100 * 1048576, locale)} / ${formatBytes(65536 * 1048576, locale)}`}
                tone="success"
              />
              <Gauge
                label={t('sample.disk')}
                value={81.2}
                detail={formatBytes(812400 * 1048576, locale)}
                tone="accent"
                thresholds={{ warn: 75, danger: 90 }}
              />
              <Gauge
                label={t('sample.bandwidth')}
                value={93}
                detail="930 Mbps"
                tone="warning"
                thresholds={{ warn: 75, danger: 90 }}
              />
            </CardContent>
          </Card>
        </Section>

        <Section id="data" title={t('sections.data')}>
          <Card>
            <CardContent>
              <DataTable
                caption={t('sample.servers')}
                data={SERVERS}
                columns={columns}
                getRowId={(r) => r.name}
                primaryColumnId="name"
                selectable
                pageSize={5}
              />
            </CardContent>
          </Card>
        </Section>

        <Section id="feedback" title={t('sections.feedback')}>
          <div className="grid gap-3 lg:grid-cols-2">
            <Alert tone="info" title={t('sample.alertInfo')}>
              {t('sample.alertInfoDesc')}
            </Alert>
            <Alert
              tone="danger"
              title={t('sample.alertDanger')}
              action={
                <Button size="sm" variant="outline">
                  {tc('actions.retry')}
                </Button>
              }
            >
              {t('sample.alertDangerDesc')}
            </Alert>
            <Alert tone="success" title={tc('status.succeeded')} />
            <Alert tone="warning" title={tc('status.drift')} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <EmptyState
                icon={Globe}
                title={t('sample.emptyTitle')}
                description={t('sample.emptyDesc')}
                action={
                  <Button>
                    <Plus aria-hidden />
                    {tc('actions.create')}
                  </Button>
                }
              />
            </Card>
            <Card className="flex flex-col gap-3 p-5" aria-label={t('sample.loadMore')}>
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-24 w-full" />
              <Button
                variant="secondary"
                className="self-start"
                onClick={() => toast.success(t('sample.toastText'))}
              >
                {t('sample.toast')}
              </Button>
            </Card>
          </div>
        </Section>

        <Section id="overlays" title={t('sections.overlays')}>
          <div className="flex flex-wrap gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">{t('sample.openDialog')}</Button>
              </DialogTrigger>
              <DialogContent
                title={t('sample.dialogTitle')}
                description={t('sample.dialogDesc')}
                footer={<Button>{tc('actions.confirm')}</Button>}
              >
                <CodeBlock code="curl -fsSL https://panel.itso.local/install.sh | sudo bash -s -- --role node --join 7Hk2pQ9x" />
              </DialogContent>
            </Dialog>
            <Drawer>
              <DrawerTrigger asChild>
                <Button variant="outline">{t('sample.openDrawer')}</Button>
              </DrawerTrigger>
              <DrawerContent title={t('sample.dialogTitle')} description={t('sample.dialogDesc')}>
                <div className="p-5">
                  <ProgressBar label="CPU" value={37} showValue />
                </div>
              </DrawerContent>
            </Drawer>
            <Button variant="danger" onClick={() => setConfirmOpen(true)}>
              <Trash2 aria-hidden />
              {t('sample.deleteAccount')}
            </Button>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title={t('sample.deleteAccount')}
              description={t('sample.deleteDesc', { name: 'anphat' })}
              confirmName="anphat"
              confirmLabel={tc('actions.delete')}
              onConfirm={() => {
                toast.success(tc('status.terminated'));
              }}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">{tc('actions.more')}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>
                  <Cpu aria-hidden />
                  {tc('actions.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem tone="danger">
                  <Trash2 aria-hidden />
                  {tc('actions.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip content={t('sample.tooltip')}>
              <Button variant="ghost" size="icon" aria-label={t('sample.tooltip')}>
                <HardDrive aria-hidden />
              </Button>
            </Tooltip>
          </div>
        </Section>

        <Section id="navigation" title={t('sections.navigation')}>
          <Breadcrumb
            items={[
              { label: 'ITSO Panel', href: '/admin/' },
              { label: t('sample.servers'), href: '#' },
              { label: 'srv-hn-01' },
            ]}
          />
          <Tabs defaultValue="t1">
            <TabsList>
              <TabsTrigger value="t1">{t('sample.tab1')}</TabsTrigger>
              <TabsTrigger value="t2">{t('sample.tab2')}</TabsTrigger>
              <TabsTrigger value="t3">{t('sample.tab3')}</TabsTrigger>
            </TabsList>
            <TabsContent value="t1">
              {t('sample.tabContent', { name: t('sample.tab1') })}
            </TabsContent>
            <TabsContent value="t2">
              {t('sample.tabContent', { name: t('sample.tab2') })}
            </TabsContent>
            <TabsContent value="t3">
              {t('sample.tabContent', { name: t('sample.tab3') })}
            </TabsContent>
          </Tabs>
          <Pagination page={page} pageCount={7} onPageChange={setPage} />
        </Section>

        <Section id="charts" title={t('sections.charts')}>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title={t('sample.network')} description="Mbps" />
              <CardContent>
                <AreaChart
                  ariaLabel={t('sample.network')}
                  data={NETWORK}
                  xKey="time"
                  series={[
                    { key: 'in', label: t('sample.inbound') },
                    { key: 'out', label: t('sample.outbound') },
                  ]}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader title={t('sample.packages')} />
              <CardContent>
                <DonutChart
                  ariaLabel={t('sample.packages')}
                  height={160}
                  data={[
                    { label: 'Basic', value: 18 },
                    { label: 'Business', value: 15 },
                    { label: 'Pro', value: 9 },
                  ]}
                  centerLabel={{ value: '42', caption: t('sample.accounts') }}
                />
              </CardContent>
            </Card>
            <Card className="lg:col-span-3">
              <CardHeader title={t('sample.sitesPerServer')} />
              <CardContent>
                <BarChart
                  ariaLabel={t('sample.sitesPerServer')}
                  height={200}
                  data={SERVERS.map((s) => ({ name: s.name, sites: s.accounts * 12 + 4 }))}
                  xKey="name"
                  series={[{ key: 'sites', label: t('sample.websites') }]}
                />
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section id="jobs" title={t('sections.jobs')}>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardContent>
                <JobProgress
                  title={t('sample.jobTitle')}
                  status="running"
                  steps={[
                    {
                      op: 'account.ensure',
                      label: 'Kiểm tra tài khoản anphat',
                      state: 'succeeded',
                    },
                    { op: 'php.pool.apply', label: 'PHP-FPM pool 8.3', state: 'succeeded' },
                    {
                      op: 'nginx.vhost.apply',
                      label: 'Nginx vhost',
                      state: 'running',
                      detail: 'nginx -t',
                    },
                    { op: 'cert.issue', label: "Let's Encrypt", state: 'pending' },
                  ]}
                />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="flex flex-col gap-3">
                <CodeBlock
                  label={t('sample.code')}
                  code={
                    'curl -fsSL https://panel.itso.local/install.sh \\\n  | sudo bash -s -- --role node --join 7Hk2pQ9x'
                  }
                />
                <Separator />
                <JobProgress
                  title="Backup anphat"
                  status="failed"
                  steps={[
                    { op: 'db.mysql.dump', label: 'Dump database', state: 'succeeded' },
                    {
                      op: 'backup.run',
                      label: 'restic backup',
                      state: 'failed',
                      detail: 'dependency_unavailable',
                    },
                  ]}
                />
              </CardContent>
            </Card>
          </div>
        </Section>
      </main>
    </div>
  );
}
