/**
 * CAPTCHA proof-of-work tự host (D-81): tìm `nonce` sao cho sha256(`${challenge}:${nonce}`) có `difficulty` bit 0 đầu.
 * Dùng chung cho Web Worker (captcha.worker.ts), Vitest và handler demo (src/demo).
 */
export function leadingZeroBits(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

export async function powHash(challenge: string, nonce: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(`${challenge}:${nonce}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function powValid(challenge: string, nonce: string, difficulty: number) {
  return (
    /^[0-9]{1,12}$/.test(nonce) && leadingZeroBits(await powHash(challenge, nonce)) >= difficulty
  );
}

/** Thử nonce 0, 1, 2… tới khi đạt; `onProgress` báo số lần thử sau mỗi 1024 lần, `signal` để hủy. */
export async function solvePow(
  challenge: string,
  difficulty: number,
  opts: { signal?: AbortSignal; onProgress?: ((tries: number) => void) | undefined } = {},
): Promise<string> {
  for (let i = 0; i < 1e12; i++) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const nonce = String(i);
    if (leadingZeroBits(await powHash(challenge, nonce)) >= difficulty) return nonce;
    if (i % 1024 === 1023) opts.onProgress?.(i + 1);
  }
  throw new Error('pow: không tìm được nonce');
}
