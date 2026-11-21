import { solvePow } from './pow';

/** Giải trong Web Worker; môi trường không có Worker (test) thì giải ngay trên luồng chính. */
export function solveCaptcha(
  challenge: string,
  difficulty: number,
  onProgress?: (tries: number) => void,
): { promise: Promise<string>; cancel: () => void } {
  if (typeof Worker === 'undefined') {
    const ac = new AbortController();
    return {
      promise: solvePow(challenge, difficulty, { signal: ac.signal, onProgress }),
      cancel: () => ac.abort(),
    };
  }
  const w = new Worker(new URL('./captcha.worker.ts', import.meta.url), { type: 'module' });
  const promise = new Promise<string>((resolve, reject) => {
    w.onmessage = (e: MessageEvent<{ nonce?: string; tries?: number; error?: string }>) => {
      if (e.data.tries !== undefined) onProgress?.(e.data.tries);
      if (e.data.nonce !== undefined) {
        resolve(e.data.nonce);
        w.terminate();
      }
      if (e.data.error !== undefined) {
        reject(new Error(e.data.error));
        w.terminate();
      }
    };
    w.onerror = (e) => {
      reject(new Error(e.message));
      w.terminate();
    };
  });
  w.postMessage({ challenge, difficulty });
  return { promise, cancel: () => w.terminate() };
}
