import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFmt } from '@/shared/format/useFmt';
import { Alert } from '@/ui/Alert';
import { Button } from '@/ui/Button';
import { Checkbox } from '@/ui/Checkbox';
import { CodeBlock } from '@/ui/CodeBlock';
import { Dialog, DialogContent } from '@/ui/Dialog';
import { ErrorState } from '@/shared/page/states';
import type { components } from '@/api/generated/admin/schema';
import { send, type Row } from '../api';
import { useAction } from '../useAction';

type Dest = Row<'/api/v1/admin/backup-destinations'>;
type Kit = components['schemas']['RecoveryKit'];

/** Nội dung tệp bộ khôi phục (văn bản thuần) để SA lưu offline. */
export function kitText(kit: Kit): string {
  const cfg = Object.entries(kit.destination.config)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');
  const repos = kit.repositories
    .map((r) => `- ${r.label}\n  repo: ${r.path}\n  password: ${r.password}`)
    .join('\n');
  return [
    '# ITSO Panel recovery kit',
    `# generated_at: ${kit.generated_at}`,
    `destination: ${kit.destination.name} (${kit.destination.type})`,
    // CLI `itso backup panel-restore` cần uuid đích (khóa SSH/host key SFTP theo đích).
    `destination_uuid: ${kit.destination.uuid}`,
    cfg,
    'repositories:',
    repos,
    `panel_public_key: ${kit.panel_public_key}`,
    `panel_private_key: ${kit.panel_private_key}`,
    '',
  ].join('\n');
}

/**
 * Bộ khôi phục của một đích (D-82): mật khẩu repo + khóa riêng của panel, đủ để khôi phục khi mất panel.
 * Lần đầu sau khi tạo đích hiện ngay; SA phải xác nhận đã lưu offline. Xem lại cần step-up (API trả 403
 * `mfa_step_up_required`, hộp thoại step-up chung tự hỏi mã).
 */
export function RecoveryKitDialog({ dest, onClose }: { dest: Dest; onClose: () => void }) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  const [saved, setSaved] = useState(false);
  const q = useQuery({
    queryKey: ['admin', 'backups', 'kit', dest.uuid],
    queryFn: () =>
      send<Kit>('POST', '/api/v1/admin/backup-destinations/{id}:recovery-kit', {
        path: { id: dest.uuid },
      }),
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
  const ack = useAction(
    () =>
      send('POST', '/api/v1/admin/backup-destinations/{id}:recovery-kit-ack', {
        path: { id: dest.uuid },
      }),
    { success: t('bk.kitSaved'), invalidate: [['admin', 'backups']], onSuccess: onClose },
  );
  const kit = q.data;
  const first = kit?.first_view ?? false;
  // Chỉ cho đóng khi đã tải xong và không phải lần xem đầu (hoặc tải lỗi).
  const locked = q.isError ? false : !kit || first;
  const download = () => {
    if (!kit) return;
    const url = URL.createObjectURL(new Blob([kitText(kit)], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `itso-recovery-kit-${dest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        // Lần đầu: không đóng được khi chưa xác nhận đã lưu (tránh mất bộ khôi phục).
        if (!o && !locked) onClose();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => locked && e.preventDefault()}
        onInteractOutside={(e) => locked && e.preventDefault()}
        title={t('bk.kitTitle', { name: dest.name })}
        description={first ? t('bk.kitFirstHint') : t('bk.kitAgainHint')}
        className="max-w-2xl"
      >
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {kit && (
          <div className="flex flex-col gap-4">
            <Alert tone="warning" title={t('bk.kitWarnTitle')}>
              {t('bk.kitWarn')}
            </Alert>
            <section aria-labelledby="kit-repos" className="flex flex-col gap-2">
              <h3 id="kit-repos" className="font-medium">
                {t('bk.kitRepos')}
              </h3>
              {kit.repositories.map((r) => (
                <div key={r.path} className="rounded-md border border-border p-3">
                  <p className="mb-2 font-medium">{r.label}</p>
                  <CodeBlock code={r.path} label={t('bk.kitRepoPath')} wrap />
                  <CodeBlock code={r.password} label={t('bk.kitRepoPassword')} wrap />
                </div>
              ))}
            </section>
            <section aria-labelledby="kit-key" className="flex flex-col gap-2">
              <h3 id="kit-key" className="flex items-center gap-2 font-medium">
                <KeyRound aria-hidden className="size-4" />
                {t('bk.kitPanelKey')}
              </h3>
              <p className="text-sm text-muted">{t('bk.kitPanelKeyHint')}</p>
              <CodeBlock code={kit.panel_private_key} label={t('bk.kitPrivateKey')} wrap />
            </section>
            <p className="text-sm text-muted">
              {t('bk.kitGenerated', { at: fmt.dateTime(kit.generated_at) })}
            </p>
            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="outline" onClick={download}>
                <Download aria-hidden />
                {t('bk.kitDownload')}
              </Button>
              {first ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <label className="flex items-center gap-2 text-base">
                    <Checkbox checked={saved} onCheckedChange={(c) => setSaved(c === true)} />
                    {t('bk.kitConfirm')}
                  </label>
                  <Button disabled={!saved || ack.isPending} onClick={() => ack.mutate()}>
                    {t('bk.kitDone')}
                  </Button>
                </div>
              ) : (
                <Button onClick={onClose}>{t('bk.close')}</Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
