import { useState, type ReactNode } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ArrowLeft, ArrowRight, Rocket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { cn } from '@/shared/lib/utils';
import { SelectField, TextField } from '@/shared/page/fields';
import { InfoList } from '@/shared/page/InfoList';
import { PageHeader } from '@/shared/page/PageHeader';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { Stepper } from '@/shared/page/Stepper';
import { Badge } from '@/ui/Badge';
import { Button } from '@/ui/Button';
import { Card, CardContent } from '@/ui/Card';
import { FormField } from '@/ui/FormField';
import { list, send, type JobAccepted } from '../api';
import { useAction } from '../useAction';
import { ACCOUNT_STEPS, accountSchema, suggestUsername, type AccountForm } from './accounts';

/** Ô chọn dạng thẻ (radio) dùng trong wizard. */
export function ChoiceCard({
  name,
  value,
  checked,
  disabled,
  onChange,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-md border p-3 text-base',
        checked ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-hover',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={() => onChange(value)}
        className="mt-1 accent-[var(--itso-primary)]"
      />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

export default function AccountNewPage() {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const { control, handleSubmit, trigger, setValue, getValues } = useForm<AccountForm>({
    resolver: zodResolver(accountSchema),
    defaultValues: {
      owner_user_uuid: '',
      package_uuid: '',
      server_uuid: '',
      username: '',
      primary_domain: '',
    },
  });
  const v = useWatch({ control });
  const users = useQuery({
    queryKey: ['admin', 'users', 'portal'],
    queryFn: () => list('/api/v1/admin/users', { filters: { realm: 'portal' } }),
  });
  const packages = useQuery({
    queryKey: ['admin', 'packages', { q: '' }],
    queryFn: () => list('/api/v1/admin/hosting-packages'),
  });
  const placement = useQuery({
    queryKey: ['admin', 'placement', v.package_uuid],
    enabled: Boolean(v.package_uuid),
    queryFn: () =>
      list('/api/v1/admin/placement/suggestions', undefined, {
        query: { package: v.package_uuid },
      }),
  });
  const create = useAction(
    (f: AccountForm) =>
      send<JobAccepted>('POST', '/api/v1/admin/hosting-accounts', {
        body: { ...f, primary_domain: f.primary_domain || null },
      }),
    {
      invalidate: [['admin', 'accounts']],
      onSuccess: (r) => r.resource && void navigate({ to: `/hosting-accounts/${r.resource.uuid}` }),
    },
  );

  const labels = [
    ...ACCOUNT_STEPS.map((s) => t(`accounts.steps.${s.key}`)),
    t('accounts.steps.review'),
  ];
  const owner = users.data?.find((u) => u.uuid === v.owner_user_uuid);
  const pkg = packages.data?.find((p) => p.uuid === v.package_uuid);
  const server = placement.data?.find((s) => s.server.uuid === v.server_uuid);

  const next = async () => {
    const s = ACCOUNT_STEPS[step];
    if (s && !(await trigger([...s.fields]))) return;
    if (s?.key === 'owner' && !getValues('username') && owner) {
      setValue('username', suggestUsername(owner.name));
    }
    setStep(step + 1);
  };

  const body: ReactNode[] = [
    <SelectField
      key="owner"
      control={control}
      name="owner_user_uuid"
      label={t('accounts.owner')}
      description={t('accounts.ownerHint')}
      placeholder={t('accounts.ownerPlaceholder')}
      options={(users.data ?? []).map((u) => ({ value: u.uuid, label: `${u.name} · ${u.email}` }))}
    />,
    <FormField
      key="package"
      control={control}
      name="package_uuid"
      label={t('accounts.package')}
      render={(f) =>
        packages.isPending ? (
          <TableSkeleton rows={3} />
        ) : (
          <div id={f.id} role="radiogroup" className="grid gap-2 md:grid-cols-3">
            {(packages.data ?? [])
              .filter((p) => p.is_active)
              .map((p) => (
                <ChoiceCard
                  key={p.uuid}
                  name="package"
                  value={p.uuid}
                  checked={f.value === p.uuid}
                  onChange={(x) => {
                    f.onChange(x);
                    setValue('server_uuid', '');
                  }}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {p.name} <Badge tone="neutral">v{p.current_version}</Badge>
                  </span>
                  <span className="block text-sm text-muted">
                    {fmt.mb(p.limits.disk_mb)} · {fmt.mb(p.limits.ram_mb)} RAM ·{' '}
                    {t('accounts.sitesCount', { count: p.limits.website_limit })}
                  </span>
                </ChoiceCard>
              ))}
          </div>
        )
      }
    />,
    <FormField
      key="server"
      control={control}
      name="server_uuid"
      label={t('accounts.server')}
      description={t('accounts.placementHint')}
      render={(f) =>
        placement.isError ? (
          <ErrorState error={placement.error} onRetry={() => void placement.refetch()} />
        ) : placement.isPending ? (
          <TableSkeleton rows={2} />
        ) : (
          <div id={f.id} role="radiogroup" className="flex flex-col gap-2">
            {placement.data.map((s, i) => (
              <ChoiceCard
                key={s.server.uuid}
                name="server"
                value={s.server.uuid}
                checked={f.value === s.server.uuid}
                disabled={!s.accepting_new}
                onChange={f.onChange}
              >
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {s.server.name}
                  {i === 0 && s.accepting_new && (
                    <Badge tone="success">{t('accounts.recommended')}</Badge>
                  )}
                  <span className="text-sm font-normal text-muted">
                    {t('accounts.score', { score: s.score })}
                  </span>
                </span>
                <span className="block text-sm text-muted">{s.reasons.join(' · ')}</span>
              </ChoiceCard>
            ))}
          </div>
        )
      }
    />,
    <div key="identity" className="grid gap-4 sm:grid-cols-2">
      <TextField
        control={control}
        name="username"
        label={t('accounts.username')}
        description={t('accounts.usernameHint')}
        autoComplete="off"
      />
      <TextField
        control={control}
        name="primary_domain"
        label={t('accounts.domain')}
        description={t('accounts.domainHint')}
        placeholder="example.vn"
        optional
      />
    </div>,
    <InfoList
      key="review"
      items={[
        [t('accounts.owner'), owner ? `${owner.name} · ${owner.email}` : '—'],
        [t('accounts.package'), pkg ? `${pkg.name} v${pkg.current_version}` : '—'],
        [t('accounts.server'), server?.server.name ?? '—'],
        [
          t('accounts.username'),
          <span key="u" className="font-mono">
            {v.username}
          </span>,
        ],
        [t('accounts.domain'), v.primary_domain || '—'],
        [
          t('accounts.homePath'),
          <span key="h" className="font-mono">
            /home/{v.username}
          </span>,
        ],
      ]}
    />,
  ];

  const last = step === labels.length - 1;
  return (
    <>
      <PageHeader title={t('accounts.addTitle')} description={t('accounts.addDescription')} />
      <Card>
        <CardContent>
          <Stepper steps={labels} current={step} label={t('accounts.wizard')} onSelect={setStep} />
          <form
            noValidate
            onSubmit={(e) => {
              // Enter ở bước giữa = "Tiếp"; chỉ bước cuối mới gửi.
              if (!last) {
                e.preventDefault();
                void next();
                return;
              }
              void handleSubmit((f) => create.mutate(f))(e);
            }}
            className="flex flex-col gap-4"
          >
            <section aria-labelledby="acc-step" className="flex flex-col gap-4">
              <h2 id="acc-step" className="text-lg font-semibold">
                {labels[step]}
              </h2>
              {body[step]}
              {last && <p className="text-sm text-muted">{t('accounts.reviewHint')}</p>}
            </section>
            <div className="flex justify-between gap-2 border-t border-border pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={step === 0}
                onClick={() => setStep(step - 1)}
              >
                <ArrowLeft aria-hidden />
                {t('accounts.back')}
              </Button>
              {last ? (
                // key riêng: không tái dùng nút "Tiếp" (đổi type ngay trong lúc click sẽ gửi form).
                <Button key="submit" type="submit" disabled={create.isPending}>
                  <Rocket aria-hidden />
                  {t('accounts.create')}
                </Button>
              ) : (
                <Button key="next" type="button" onClick={() => void next()}>
                  {t('accounts.next')}
                  <ArrowRight aria-hidden />
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
