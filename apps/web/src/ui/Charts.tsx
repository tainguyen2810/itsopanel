import type { ReactElement, ReactNode } from 'react';
import {
  Area,
  AreaChart as RAreaChart,
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/shared/lib/utils';

/** Màu series lấy từ token (CSS variable) — không có mã màu trong component. */
export const chartColor = (i: number): string => `var(--itso-chart-${(i % 8) + 1})`;
const AXIS = { stroke: 'var(--itso-muted)', fontSize: 12 };
const GRID = 'var(--itso-border)';
const tooltipStyle = {
  contentStyle: {
    background: 'var(--itso-surface)',
    border: '1px solid var(--itso-border-strong)',
    borderRadius: 8,
    color: 'var(--itso-fg)',
    fontSize: 13,
  },
  labelStyle: { color: 'var(--itso-muted)' },
  itemStyle: { color: 'var(--itso-fg)' },
};

export interface Series {
  key: string;
  label: string;
}

interface Base {
  /** Mô tả cho screen reader (biểu đồ là role="img"). */
  ariaLabel: string;
  height?: number;
  className?: string;
  legend?: boolean;
}

function Frame({
  ariaLabel,
  height,
  className,
  children,
  footer,
}: Omit<Base, 'legend'> & { children: ReactNode; footer?: ReactNode }) {
  return (
    <figure className={cn('flex flex-col gap-2', className)}>
      <div
        role="img"
        aria-label={ariaLabel}
        style={{ height: height ?? 220 }}
        className="w-full min-w-0"
      >
        <ResponsiveContainer width="100%" height="100%">
          {children as ReactElement}
        </ResponsiveContainer>
      </div>
      {footer}
    </figure>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-xs" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </figcaption>
  );
}

export function AreaChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  unit,
  ...base
}: Base & { data: T[]; xKey: keyof T & string; series: Series[]; unit?: string }) {
  return (
    <Frame
      {...base}
      footer={
        base.legend === false ? null : (
          <Legend items={series.map((s, i) => ({ label: s.label, color: chartColor(i) }))} />
        )
      }
    >
      <RAreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={chartColor(i)} stopOpacity={0.35} />
              <stop offset="100%" stopColor={chartColor(i)} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey as string} tickLine={false} axisLine={false} {...AXIS} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          {...(unit === undefined ? {} : { unit })}
          {...AXIS}
        />
        <Tooltip {...tooltipStyle} />
        {series.map((s, i) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.label}
            stroke={chartColor(i)}
            strokeWidth={2}
            fill={`url(#fill-${s.key})`}
            isAnimationActive={false}
          />
        ))}
      </RAreaChart>
    </Frame>
  );
}

export function BarChart<T extends Record<string, unknown>>({
  data,
  xKey,
  series,
  ...base
}: Base & { data: T[]; xKey: keyof T & string; series: Series[] }) {
  return (
    <Frame
      {...base}
      footer={
        base.legend === false || series.length < 2 ? null : (
          <Legend items={series.map((s, i) => ({ label: s.label, color: chartColor(i) }))} />
        )
      }
    >
      <RBarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey as string} tickLine={false} axisLine={false} {...AXIS} />
        <YAxis tickLine={false} axisLine={false} width={36} allowDecimals={false} {...AXIS} />
        <Tooltip {...tooltipStyle} cursor={{ fill: 'var(--itso-surface-hover)' }} />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            fill={chartColor(i)}
            radius={[4, 4, 0, 0]}
            maxBarSize={36}
            isAnimationActive={false}
          />
        ))}
      </RBarChart>
    </Frame>
  );
}

export function DonutChart({
  data,
  centerLabel,
  ...base
}: Base & {
  data: { label: string; value: number }[];
  centerLabel?: { value: string; caption: string };
}) {
  return (
    <figure className={cn('flex flex-col items-center gap-3 sm:flex-row', base.className)}>
      <div
        role="img"
        aria-label={base.ariaLabel}
        className="relative shrink-0"
        style={{ width: base.height ?? 180, height: base.height ?? 180 }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius="68%"
              outerRadius="100%"
              paddingAngle={2}
              stroke="none"
              isAnimationActive={false}
            >
              {data.map((d, i) => (
                <Cell key={d.label} fill={chartColor(i)} />
              ))}
            </Pie>
            <Tooltip {...tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        {centerLabel && (
          <span className="pointer-events-none absolute inset-0 grid place-content-center text-center">
            <span className="text-2xl font-semibold tabular-nums">{centerLabel.value}</span>
            <span className="text-xs text-muted">{centerLabel.caption}</span>
          </span>
        )}
      </div>
      <figcaption className="flex flex-col gap-1.5 text-sm">
        {data.map((d, i) => (
          <span key={d.label} className="flex items-center gap-2">
            <span
              aria-hidden
              className="size-2.5 rounded-xs"
              style={{ background: chartColor(i) }}
            />
            <span className="text-muted">{d.label}</span>
            <span className="ml-auto pl-4 font-medium tabular-nums">{d.value}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
