/// <reference lib="webworker" />
import { solvePow } from './pow';

/** Web Worker giải CAPTCHA để không chặn giao diện. Nhận {challenge, difficulty}, trả {nonce} hoặc {error}. */
self.onmessage = (e: MessageEvent<{ challenge: string; difficulty: number }>) => {
  solvePow(e.data.challenge, e.data.difficulty, {
    onProgress: (tries) => self.postMessage({ tries }),
  }).then(
    (nonce) => self.postMessage({ nonce }),
    (err: unknown) => self.postMessage({ error: String(err) }),
  );
};
