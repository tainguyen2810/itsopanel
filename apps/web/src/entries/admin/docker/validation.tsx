import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { Alert } from '@/ui/Alert';
import { Badge } from '@/ui/Badge';
import type { components } from '@/api/generated/admin/schema';

export type Validation = components['schemas']['ComposeValidation'];
export type Finding = Validation['findings'][number];

/** Lỗi chặn còn lại sau khi trừ các rule đã override (D-96). */
export function blockingFindings(v: Validation, overridden: readonly string[] = []): Finding[] {
  return v.findings.filter((f) => f.severity === 'error' && !overridden.includes(f.rule));
}

/** Diff theo dòng (LCS) giữa hai revision compose.yaml: đủ cho file vài trăm dòng. */
export function lineDiff(a: string, b: string): { kind: 'same' | 'add' | 'del'; text: string }[] {
  const x = a.replace(/\n$/, '').split('\n');
  const y = b.replace(/\n$/, '').split('\n');
  const n = x.length;
  const m = y.length;
  // Bảng LCS phẳng (n+1)×(m+1): L(i, j) = độ dài LCS của x[i..] và y[j..].
  const L = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => L[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i * (m + 1) + j] =
        x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: { kind: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i] ?? '' });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: 'del', text: x[i++] ?? '' });
    } else {
      out.push({ kind: 'add', text: y[j++] ?? '' });
    }
  }
  while (i < n) out.push({ kind: 'del', text: x[i++] ?? '' });
  while (j < m) out.push({ kind: 'add', text: y[j++] ?? '' });
  return out;
}

/** Kết quả validator: lỗi chặn, cảnh báo, dòng viết lại (ports/limits), override của SA. */
export function ValidationView({ v }: { v: Validation }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const errors = v.findings.filter((f) => f.severity === 'error');
  const warnings = v.findings.filter((f) => f.severity === 'warning');
  const overridden = v.overrides.map((o) => o.rule);
  const blocking = blockingFindings(v, overridden);
  return (
    <div className="flex flex-col gap-3">
      {blocking.length > 0 ? (
        <Alert tone="danger" title={t('compose.blocked', { count: blocking.length })}>
          {t('compose.blockedHint')}
        </Alert>
      ) : warnings.length === 0 && v.overrides.length === 0 ? (
        <Alert tone="success" title={t('compose.valid')} />
      ) : (
        <Alert tone="success" title={t('compose.passWithNotes')} />
      )}
      {errors.length + warnings.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {[...errors, ...warnings].map((f) => (
            <li key={`${f.rule}-${f.path}`} className="flex flex-col gap-1 px-3 py-2">
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge
                  tone={
                    f.severity === 'warning'
                      ? 'warning'
                      : overridden.includes(f.rule)
                        ? 'info'
                        : 'danger'
                  }
                >
                  {f.severity === 'warning'
                    ? t('compose.warning')
                    : overridden.includes(f.rule)
                      ? t('compose.overridden')
                      : t('compose.error')}
                </Badge>
                <code className="text-sm">{f.rule}</code>
                <code className="text-sm text-muted">{f.path}</code>
              </span>
              <span className="text-sm">{f.message}</span>
              {f.severity === 'error' && !f.overridable && (
                <span className="text-xs text-muted">{t('compose.notOverridable')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {v.rewrites.length > 0 && (
        <div>
          <p className="mb-1 text-base font-medium">{t('compose.rewrites')}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {v.rewrites.map((r) => (
              <li key={r.path} className="flex flex-wrap items-center gap-1.5">
                <code className="text-muted">{r.path}</code>
                <span>
                  {r.before === null ? (
                    <span className="text-muted">{t('compose.added')}</span>
                  ) : (
                    <code className="line-through decoration-danger/70">{r.before}</code>
                  )}{' '}
                  → <code className="text-success-text">{r.after}</code>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {v.overrides.length > 0 && (
        <div>
          <p className="mb-1 text-base font-medium">{t('compose.overrides')}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {v.overrides.map((o) => (
              <li key={o.rule}>
                <code>{o.rule}</code>: {o.reason}
                {o.by && (
                  <span className="text-muted">
                    {' '}
                    · {o.by.name}
                    {o.at ? `, ${fmt.dateTime(o.at)}` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
