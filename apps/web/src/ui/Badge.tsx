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
  | 'degraded';

const TONE: Record<StatusKey, Tone> = {
  active: 'success',
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
};

interface StatusBadgeProps {
  status: StatusKey;
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
      <Badge tone={TONE[status]}>
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
        {t(`status.${status}`)}
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
