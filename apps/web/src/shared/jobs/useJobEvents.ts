import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PortalSchemas } from '@/api/portal';

type Job = PortalSchemas['Job'];

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

/**
 * Theo dõi job qua SSE (D-106, ADR 0051): mỗi sự kiện `job` ghi thẳng vào cache (mặc định ['job', uuid]).
 * Trả `true` khi luồng đang chạy (bên gọi tắt poll); lỗi SSE hoặc trình duyệt không có EventSource → `false`
 * (quay về poll). Luồng tự đóng khi job kết thúc; EventSource tự nối lại bằng Last-Event-ID khi server đóng sau 5 phút.
 */
export function useJobEvents(
  uuid: string | null,
  url: string | null | undefined,
  done: boolean,
  cacheKey: readonly unknown[] = ['job', uuid],
): boolean {
  const qc = useQueryClient();
  const keyJson = JSON.stringify(cacheKey);
  const key = uuid && url ? `${uuid}|${url}` : null;
  const [liveKey, setLiveKey] = useState<string | null>(null);
  const supported = typeof EventSource !== 'undefined';
  useEffect(() => {
    if (!key || !uuid || !url || done || !supported) return;
    let es: EventSource;
    try {
      es = new EventSource(url, { withCredentials: true });
    } catch {
      return;
    }
    const setLive = (v: boolean) => setLiveKey(v ? key : null);
    let failures = 0;
    const onJob = (e: MessageEvent<string>) => {
      try {
        const job = JSON.parse(e.data) as Job;
        failures = 0;
        setLive(true);
        qc.setQueryData(JSON.parse(keyJson) as unknown[], job);
        if (TERMINAL.has(job.state)) es.close();
      } catch {
        /* bỏ qua khung hỏng */
      }
    };
    es.addEventListener('job', onJob as EventListener);
    es.onopen = () => setLive(true);
    es.onerror = () => {
      // Lần đầu lỗi có thể là server đóng sau 5 phút (trình duyệt tự nối lại); lỗi lặp → poll.
      failures += 1;
      if (failures >= 2 || es.readyState === EventSource.CLOSED) {
        es.close();
        setLive(false);
      }
    };
    return () => {
      es.removeEventListener('job', onJob as EventListener);
      es.close();
    };
  }, [key, uuid, url, done, supported, qc, keyJson]);
  return supported && !done && key !== null && liveKey === key;
}
