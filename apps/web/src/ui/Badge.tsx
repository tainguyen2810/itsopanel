import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-border-strong bg-surface-2 text-muted',
        primary: 'border-transparent bg-primary-soft text-primary-text',
        accent: 'border-transparent bg-accent-soft text-accent-text',
        success: 'border-transparent bg-success-soft text-success-text',
        warning: 'border-transparent bg-warning-soft text-warning-text',
        danger: 'border-transparent bg-danger-soft text-danger-text',
        info: 'border-transparent bg-info-soft text-info-text',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type Tone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** Trạng thái vòng đời/job/server dùng chung (khóa trong common:status). */
export type StatusKey =
  | 'active'
  | 'drift'
  | 'inSync'
  | 'pending'
  | 'provisioning'
  | 'suspended'
  | 'failed'
  | 'terminated'
  | 'running'
  | 'succeeded'
  | 'cancelled'
  | 'queued'
  | 'online'
  | 'offline'
  | 'degraded'
  | 'ready'
  | 'locked'
  | 'disabled'
  | 'expiring'
  | 'expired'
  | 'valid'
  | 'stopped'
  | 'exited'
  | 'installed'
  | 'available'
  | 'upgradable'
  | 'verifying'
  | 'verified'
  | 'firing'
  | 'resolved'
  | 'migrating'
  | 'purged'
  | 'timed_out'
  | 'cancel_requested'
  | 'pass'
  | 'warn'
  | 'fail'
  | 'success'
  | 'failure'
  | 'error'
  | 'skipped'
  | 'connected'
  | 'disconnected'
  | 'preflight'
  | 'syncing'
  | 'cutover'
  | 'completed'
  | 'rolled_back'
  | 'deleting'
  | 'denied'
  | 'acknowledged'
  | 'unreachable'
  | 'revoked'
  | 'waiting_agent'
  | 'holding';

const TONE: Record<StatusKey, Tone> = {
  active: 'success',
  drift: 'warning',
  inSync: 'success',
  succeeded: 'success',
  online: 'success',
  pending: 'neutral',
  queued: 'neutral',
  provisioning: 'info',
  running: 'info',
  suspended: 'warning',
  cancelled: 'neutral',
  failed: 'danger',
  offline: 'danger',
  degraded: 'warning',
  terminated: 'neutral',
  ready: 'success',
  locked: 'warning',
  disabled: 'neutral',
  expiring: 'warning',
  expired: 'danger',
  valid: 'success',
  stopped: 'neutral',
  exited: 'neutral',
  installed: 'success',
  available: 'neutral',
  upgradable: 'info',
  verifying: 'info',
  verified: 'success',
  firing: 'danger',
  resolved: 'success',
  migrating: 'info',
  purged: 'neutral',
  timed_out: 'danger',
  cancel_requested: 'warning',
  pass: 'success',
  warn: 'warning',
  fail: 'danger',
  success: 'success',
  failure: 'danger',
  error: 'danger',
  skipped: 'neutral',
  connected: 'success',
  disconnected: 'danger',
  preflight: 'info',
  syncing: 'info',
  cutover: 'warning',
  completed: 'success',
  rolled_back: 'neutral',
  deleting: 'warning',
  denied: 'danger',
  acknowledged: 'info',
  unreachable: 'danger',
  revoked: 'neutral',
  waiting_agent: 'warning',
  holding: 'info',
};

/** Trạng thái có trong bảng (dữ liệu API có thể có giá trị mới: hiện nguyên văn, tông trung tính). */
export function isStatusKey(s: string): s is StatusKey {
  return s in TONE;
}

interface StatusBadgeProps {
  status: StatusKey | (string & {});
  /** Mô hình desired/observed (D-xx): khi spec_version ≠ observed_version thì hiện "Lệch cấu hình". */
  desiredVersion?: number;
  observedVersion?: number | null;
  className?: string;
}

/** Huy hiệu trạng thái kèm chấm màu; không chỉ dựa vào màu (luôn có chữ). */
export function StatusBadge({
  status,
  desiredVersion,
  observedVersion,
  className,
}: StatusBadgeProps) {
  const { t } = useTranslation('common');
  const drift =
    desiredVersion !== undefined &&
    observedVersion !== undefined &&
    desiredVersion !== observedVersion;
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Badge tone={isStatusKey(status) ? TONE[status] : 'neutral'}>
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {isStatusKey(status) ? t(`status.${status}`) : status}
      </Badge>
      {desiredVersion !== undefined && (
        <Badge
          tone={drift ? 'warning' : 'neutral'}
          title={`${t('status.desired')}: v${desiredVersion} · ${t('status.observed')}: ${observedVersion === null || observedVersion === undefined ? '—' : `v${observedVersion}`}`}
        >
          {drift ? t('status.drift') : t('status.inSync')}
        </Badge>
      )}
    </span>
  );
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
  info: 'neutral',
};

/** Mức độ nghiêm trọng (sự kiện bảo mật, cảnh báo). */
export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const { t } = useTranslation('common');
  return (
    <Badge tone={SEVERITY_TONE[severity]} {...(className ? { className } : {})}>
      {t(`severity.${severity}`)}
    </Badge>
  );
}
