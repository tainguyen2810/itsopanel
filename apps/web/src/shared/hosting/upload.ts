/**
 * Upload resumable kiểu tus (D-75, Prompt 6.3/6.5): chunk 8 MiB theo Content-Range; server trả `received`.
 * Sai offset → 409 kèm `errors.received` để đồng bộ lại; tạm dừng/tiếp tục hỏi lại server trước khi gửi tiếp.
 */
import { ApiError } from '@/api/http';

export const CHUNK = 8 * 1024 * 1024;

export interface UploadSession {
  uuid: string;
  path: string;
  size: number;
  chunk_size: number;
  received: number;
  status: 'receiving' | 'committing' | 'completed' | 'failed' | 'cancelled' | 'expired';
  job_uuid: string | null;
}

export interface UploadApi {
  create(path: string, size: number, overwrite: boolean): Promise<UploadSession>;
  chunk(uuid: string, body: Blob, range: string): Promise<UploadSession>;
  status(uuid: string): Promise<UploadSession>;
  cancel(uuid: string): Promise<void>;
}

export type UploadState =
  'idle' | 'uploading' | 'committing' | 'paused' | 'done' | 'error' | 'cancelled';

/** Lỗi khi job ghi file vào thư mục account (fs.upload.commit) không thành công. */
export class UploadCommitError extends Error {
  constructor(readonly status: UploadSession['status']) {
    super(`upload ${status}`);
  }
}

/** Khoảng byte tiếp theo [start, end] (end bao gồm) hoặc null khi đã đủ. */
export function nextRange(
  received: number,
  size: number,
  chunk = CHUNK,
): { start: number; end: number } | null {
  if (received >= size) return null;
  const start = Math.max(0, received);
  return { start, end: Math.min(size, start + chunk) - 1 };
}

/** Header Content-Range cho khoảng [start, end] của file size byte. */
export function contentRange(start: number, end: number, size: number): string {
  return `bytes ${start}-${end}/${size}`;
}

/** `received` server báo trong lỗi 409 sai offset (errors.received[0]); null nếu không phải lỗi đó. */
export function receivedFromConflict(e: unknown): number | null {
  if (!(e instanceof ApiError) || e.problem.status !== 409) return null;
  const v = (e.problem as { errors?: Record<string, string[]> }).errors?.received?.[0];
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export interface UploadSnapshot {
  state: UploadState;
  received: number;
  size: number;
  error: unknown;
  session: UploadSession | null;
}

/** Một lần tải file lên: start → (pause ↔ resume) → committing (job ghi file) → done | error | cancelled. */
export class Uploader {
  state: UploadState = 'idle';
  received = 0;
  error: unknown = null;
  session: UploadSession | null = null;
  /** Nhịp hỏi trạng thái khi server đang ghi file (ms); test đặt 0. */
  pollMs = 500;
  private running = false;
  private stop = false;

  constructor(
    readonly file: Blob,
    readonly target: string,
    private readonly api: UploadApi,
    private readonly onChange: (s: UploadSnapshot) => void = () => {},
    readonly overwrite = false,
  ) {}

  get size(): number {
    return Math.max(1, this.file.size);
  }

  snapshot(): UploadSnapshot {
    return {
      state: this.state,
      received: this.received,
      size: this.size,
      error: this.error,
      session: this.session,
    };
  }

  private set(state: UploadState, error: unknown = null) {
    this.state = state;
    this.error = error;
    this.onChange(this.snapshot());
  }

  async start(): Promise<void> {
    if (this.running || this.state === 'done' || this.state === 'cancelled') return;
    this.stop = false;
    this.running = true;
    this.set('uploading');
    try {
      if (this.session === null) {
        this.session = await this.api.create(this.target, this.size, this.overwrite);
      } else {
        this.session = await this.api.status(this.session.uuid);
      }
      this.received = this.session.received;
      const chunk = this.session.chunk_size > 0 ? this.session.chunk_size : CHUNK;
      let r = nextRange(this.received, this.size, chunk);
      while (r !== null && !this.stop) {
        const body =
          this.file.size === 0
            ? new Blob([new Uint8Array(1)])
            : this.file.slice(r.start, r.end + 1);
        try {
          this.session = await this.api.chunk(
            this.session.uuid,
            body,
            contentRange(r.start, r.end, this.size),
          );
          this.received = this.session.received;
        } catch (e) {
          const at = receivedFromConflict(e);
          if (at === null) throw e;
          this.received = at; // server đã có tới `at`: gửi tiếp từ đó
        }
        this.onChange(this.snapshot());
        r = nextRange(this.received, this.size, chunk);
      }
      if (r === null) {
        await this.commit();
        this.running = false;
        this.set('done');
      } else {
        this.running = false;
        this.set('paused');
      }
    } catch (e) {
      this.running = false;
      this.set('error', e);
    }
  }

  /** Đủ byte: chờ job fs.upload.commit ghi file vào thư mục rồi mới báo xong (để danh sách file thấy ngay). */
  private async commit(): Promise<void> {
    const sess = this.session;
    if (sess === null) return;
    let cur = sess;
    if (cur.status === 'receiving' || cur.status === 'committing') this.set('committing');
    for (let i = 0; cur.status === 'receiving' || cur.status === 'committing'; i++) {
      if (i >= 240) throw new UploadCommitError(cur.status);
      await new Promise((ok) => setTimeout(ok, Math.min(this.pollMs * (1 + i), this.pollMs * 4)));
      cur = await this.api.status(sess.uuid);
    }
    this.session = cur;
    if (cur.status !== 'completed') throw new UploadCommitError(cur.status);
  }

  /** Dừng sau chunk đang gửi. */
  pause(): void {
    if (this.state === 'uploading') this.stop = true;
  }

  /** Tiếp tục (hỏi lại server đã nhận bao nhiêu). */
  resume(): Promise<void> {
    return this.start();
  }

  async cancel(): Promise<void> {
    this.stop = true;
    if (this.session && this.state !== 'done') {
      try {
        await this.api.cancel(this.session.uuid);
      } catch {
        /* phiên đã hết hạn hoặc đang ghi: bỏ qua */
      }
    }
    this.set('cancelled');
  }
}
