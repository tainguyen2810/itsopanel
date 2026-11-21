import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { get, send } from '@/shared/api/realm';
import { errorText } from '@/shared/api/useAction';
import { useFmt } from '@/shared/format/useFmt';
import { Button } from '@/ui/Button';
import { ProgressBar } from '@/ui/ProgressBar';
import {
  UploadCommitError,
  Uploader,
  type UploadApi,
  type UploadSession,
  type UploadSnapshot,
} from '../upload';

/** API upload theo realm (admin/portal) cho một account. */
export function uploadApi(account: string): UploadApi {
  return {
    create: (path, size, overwrite) =>
      send<UploadSession>('POST', '/hosting-accounts/{id}/files/uploads', {
        path: { id: account },
        body: { path, size, overwrite },
      }),
    chunk: (uuid, body, range) =>
      send<UploadSession>('PATCH', '/hosting-accounts/{id}/files/uploads/{upload}', {
        path: { id: account, upload: uuid },
        body,
        headers: { 'Content-Range': range, 'Content-Type': 'application/octet-stream' },
      }),
    status: (uuid) =>
      get('/hosting-accounts/{id}/files/uploads/{upload}', {
        path: { id: account, upload: uuid },
      }) as Promise<UploadSession>,
    cancel: (uuid) =>
      send<undefined>('DELETE', '/hosting-accounts/{id}/files/uploads/{upload}', {
        path: { id: account, upload: uuid },
      }),
  };
}

export interface UploadItem {
  id: number;
  name: string;
  up: Uploader;
  snap: UploadSnapshot;
}

/** Danh sách upload của trang File Manager; onDone gọi khi một file đã ghi xong (làm mới thư mục). */
export function useUploads(account: string, onDone: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const seq = useRef(0);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });
  const add = useCallback(
    (file: File, target: string) => {
      const id = ++seq.current;
      const up = new Uploader(file, target, uploadApi(account), (snap) => {
        setItems((xs) => xs.map((x) => (x.id === id ? { ...x, snap } : x)));
        if (snap.state === 'done') doneRef.current();
      });
      setItems((xs) => [...xs, { id, name: file.name, up, snap: up.snapshot() }]);
      void up.start();
    },
    [account],
  );
  const dismiss = (id: number) => setItems((xs) => xs.filter((x) => x.id !== id));
  return { items, add, dismiss };
}

/** Tiến độ upload: tạm dừng / tiếp tục / hủy từng file. */
export function UploadList({
  items,
  onDismiss,
}: {
  items: UploadItem[];
  onDismiss: (id: number) => void;
}) {
  const { t } = useTranslation('admin');
  const fmt = useFmt();
  if (items.length === 0) return null;
  return (
    <section
      aria-label={t('files.uploads')}
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <h3 className="text-sm font-medium">{t('files.uploads')}</h3>
      <ul className="flex flex-col gap-3">
        {items.map(({ id, name, up, snap }) => {
          const pct = Math.floor((snap.received / snap.size) * 100);
          const finished = snap.state === 'done' || snap.state === 'cancelled';
          return (
            <li key={id} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate font-mono">{name}</span>
                <span className="text-muted">
                  {t(`files.uploadState.${snap.state}`)} · {fmt.bytes(snap.received)} /{' '}
                  {fmt.bytes(snap.size)}
                </span>
              </div>
              <ProgressBar
                value={pct}
                label={t('files.uploadProgress', { name })}
                tone={
                  snap.state === 'error' ? 'danger' : snap.state === 'done' ? 'success' : 'primary'
                }
              />
              {snap.state === 'error' && (
                <p className="text-sm text-danger-text">
                  {snap.error instanceof UploadCommitError
                    ? t('files.uploadCommitFailed')
                    : errorText(snap.error)}
                </p>
              )}
              <div className="flex gap-2">
                {snap.state === 'uploading' && (
                  <Button size="sm" variant="outline" onClick={() => up.pause()}>
                    <Pause aria-hidden />
                    {t('files.pause')}
                  </Button>
                )}
                {(snap.state === 'paused' || snap.state === 'error') && (
                  <Button size="sm" variant="outline" onClick={() => void up.resume()}>
                    <Play aria-hidden />
                    {t('files.resume')}
                  </Button>
                )}
                {!finished ? (
                  <Button size="sm" variant="ghost" onClick={() => void up.cancel()}>
                    <X aria-hidden />
                    {t('files.cancelUpload')}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => onDismiss(id)}>
                    {t('files.dismiss')}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
