import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import SharedWebsiteDetailPage, {
  SettingsCard,
  keyOf,
  type Site,
} from '@/shared/hosting/pages/WebsiteDetailPage';
import { ErrorState, TableSkeleton } from '@/shared/page/states';
import { Alert } from '@/ui/Alert';
import { DropdownMenuItem } from '@/ui/DropdownMenu';
import { Input } from '@/ui/Input';
import { Label } from '@/ui/Label';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Checkbox';
import { get, send, type Data } from '../api';
import { useAction } from '../useAction';

/** Chi tiết website (Admin): trang dùng chung + quét mã độc và tab WAF (chỉ Admin). */
export default function WebsiteDetailPage() {
  const { t } = useTranslation('admin');
  return (
    <SharedWebsiteDetailPage
      extraActions={(w) => <ScanItem w={w} />}
      extraTabs={(w) => [{ value: 'waf', label: t('sites.tabs.waf'), content: <WafTab w={w} /> }]}
    />
  );
}

function ScanItem({ w }: { w: Site }) {
  const { t } = useTranslation('admin');
  const scan = useAction(() =>
    send('POST', '/api/v1/admin/websites/{id}/scans', { path: { id: w.uuid }, body: {} }),
  );
  return <DropdownMenuItem onSelect={() => scan.mutate()}>{t('sites.scan')}</DropdownMenuItem>;
}

function WafTab({ w }: { w: Site }) {
  const q = useQuery({
    queryKey: [...keyOf(w.uuid), 'waf'],
    queryFn: () => get('/api/v1/admin/websites/{id}/waf', { path: { id: w.uuid } }),
  });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <TableSkeleton rows={4} />;
  return <WafForm w={w} value={q.data} />;
}

function WafForm({ w, value }: { w: Site; value: Data<'/api/v1/admin/websites/{id}/waf'> }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [enabled, setEnabled] = useState(value.enabled);
  const [mode, setMode] = useState(value.mode);
  const [level, setLevel] = useState(String(value.paranoia_level));
  const [excl, setExcl] = useState(value.rule_exclusions.join(', '));
  const ids = excl
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const bad = ids.some((x) => !/^[0-9]{6}$/.test(x));
  const save = useAction(() =>
    send('PATCH', '/api/v1/admin/websites/{id}/waf', {
      path: { id: w.uuid },
      body: { enabled, mode, paranoia_level: Number(level), rule_exclusions: ids },
    }),
  );
  return (
    <SettingsCard
      title={t('sites.wafTitle')}
      description={t('sites.wafHint', {
        count: value.blocked_24h,
        time: fmt.rel(value.updated_at),
      })}
      pending={save.isPending || bad}
      onSubmit={() => !bad && save.mutate()}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="waf-on">{t('sites.wafEnabled')}</Label>
          <Switch id="waf-on" checked={enabled} onCheckedChange={setEnabled} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="waf-mode">{t('sites.wafMode')}</Label>
          <Select
            id="waf-mode"
            value={mode}
            onValueChange={(v) => setMode(v as typeof mode)}
            options={[
              { value: 'detect', label: t('sites.wafDetect') },
              { value: 'block', label: t('sites.wafBlock') },
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="waf-level">{t('sites.wafLevel')}</Label>
          <Select
            id="waf-level"
            value={level}
            onValueChange={setLevel}
            options={['1', '2', '3', '4'].map((x) => ({ value: x, label: `PL${x}` }))}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="waf-excl">{t('sites.wafExclusions')}</Label>
        <Input
          id="waf-excl"
          value={excl}
          onChange={(e) => setExcl(e.target.value)}
          aria-invalid={bad}
          aria-describedby="waf-excl-hint"
          placeholder="942100, 949110"
        />
        <p
          id="waf-excl-hint"
          className={bad ? 'text-xs text-danger-text' : 'text-xs text-muted'}
          {...(bad ? { role: 'alert' } : {})}
        >
          {bad ? t('sites.errors.ruleId') : t('sites.wafExclusionsHint')}
        </p>
      </div>
      {mode === 'block' && value.mode === 'detect' && (
        <Alert tone="warning" title={t('sites.wafBlockWarn')} />
      )}
    </SettingsCard>
  );
}
