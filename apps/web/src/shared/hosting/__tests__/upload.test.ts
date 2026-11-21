import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/http';
import {
  CHUNK,
  UploadCommitError,
  Uploader,
  contentRange,
  nextRange,
  receivedFromConflict,
  type UploadApi,
  type UploadSession,
} from '../upload';

function conflict(received: number) {
  return new ApiError({
    type: 'https://docs.itso.local/errors/conflict',
    title: 'Sai vị trí chunk',
    status: 409,
    code: 'conflict',
    errors: { received: [String(received)] },
  } as never);
}

/** Server giả: giữ received, kiểm offset như Laravel FileService::chunk. */
function fakeServer(opts: { failAt?: number; lose?: boolean } = {}) {
  const s: UploadSession = {
    uuid: 'u1',
    path: 'a.bin',
    size: 0,
    chunk_size: 4,
    received: 0,
    status: 'receiving',
    job_uuid: null,
  };
  const ranges: string[] = [];
  let failed = false;
  const api: UploadApi = {
    create: async (path, size) => ({ ...Object.assign(s, { path, size }) }),
    status: async () => ({ ...s }),
    cancel: async () => {
      s.status = 'cancelled';
    },
    chunk: async (_u, body, range) => {
      ranges.push(range);
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      const a = Number(m?.[1]);
      const b = Number(m?.[2]);
      if (opts.failAt !== undefined && a === opts.failAt && !failed) {
        failed = true;
        throw new Error('mạng rớt');
      }
      if (a !== s.received) throw conflict(s.received);
      expect(body.size).toBe(b - a + 1);
      s.received = b + 1;
      if (s.received === s.size) s.status = 'completed';
      return { ...s };
    },
  };
  return { s, api, ranges };
}

describe('upload chunk', () => {
  it('nextRange / contentRange', () => {
    expect(nextRange(0, 10, 4)).toEqual({ start: 0, end: 3 });
    expect(nextRange(8, 10, 4)).toEqual({ start: 8, end: 9 });
    expect(nextRange(10, 10, 4)).toBeNull();
    expect(nextRange(0, 20 * 1024 * 1024)).toEqual({ start: 0, end: CHUNK - 1 });
    expect(contentRange(8, 9, 10)).toBe('bytes 8-9/10');
  });

  it('receivedFromConflict chỉ nhận 409 có errors.received hợp lệ', () => {
    expect(receivedFromConflict(conflict(5))).toBe(5);
    expect(receivedFromConflict(new Error('x'))).toBeNull();
    expect(
      receivedFromConflict(
        new ApiError({ type: 't', title: 't', status: 409, code: 'conflict' } as never),
      ),
    ).toBeNull();
  });

  it('tải đủ theo chunk của server rồi done', async () => {
    const { api, ranges, s } = fakeServer();
    const states: string[] = [];
    const up = new Uploader(new Blob(['0123456789']), 'a.bin', api, (x) => states.push(x.state));
    await up.start();
    expect(up.state).toBe('done');
    expect(ranges).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
    expect(s.status).toBe('completed');
    expect(states[0]).toBe('uploading');
  });

  it('lỗi mạng giữa chừng → error; resume hỏi lại server và gửi tiếp từ received', async () => {
    const { api, ranges } = fakeServer({ failAt: 4 });
    const up = new Uploader(new Blob(['0123456789']), 'a.bin', api);
    await up.start();
    expect(up.state).toBe('error');
    expect(up.received).toBe(4);
    await up.resume();
    expect(up.state).toBe('done');
    expect(ranges).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 4-7/10', 'bytes 8-9/10']);
  });

  it('409 sai offset → đồng bộ theo received của server', async () => {
    const { api, s, ranges } = fakeServer();
    const up = new Uploader(new Blob(['0123456789']), 'a.bin', api);
    // Tab khác đã gửi 8 byte đầu.
    const orig = api.status;
    api.status = async () => ({ ...(await orig('u1')), received: 0 });
    up.session = await api.create('a.bin', 10, false);
    s.received = 8;
    await up.resume();
    expect(up.state).toBe('done');
    expect(ranges).toEqual(['bytes 0-3/10', 'bytes 8-9/10']);
  });

  it('pause dừng sau chunk đang gửi; resume tiếp tục; cancel gọi server', async () => {
    const { api, s } = fakeServer();
    let up: Uploader | null = null;
    let paused = false;
    up = new Uploader(new Blob(['0123456789']), 'a.bin', api, (x) => {
      if (x.received === 4 && x.state === 'uploading' && !paused) {
        paused = true;
        up?.pause();
      }
    });
    await up.start();
    expect(up.state).toBe('paused');
    expect(up.received).toBe(4);
    await up.resume();
    expect(up.state).toBe('done');

    const { api: api2, s: s2 } = fakeServer();
    const c = new Uploader(new Blob(['0123456789']), 'b.bin', api2, (x) => {
      if (x.received === 4) c.pause();
    });
    await c.start();
    await c.cancel();
    expect(c.state).toBe('cancelled');
    expect(s2.status).toBe('cancelled');
    expect(s.status).toBe('completed');
  });

  it('file rỗng gửi 1 byte như kích thước phiên (size ≥ 1)', async () => {
    const { api, ranges } = fakeServer();
    const up = new Uploader(new Blob([]), 'empty.txt', api);
    await up.start();
    expect(up.state).toBe('done');
    expect(ranges).toEqual(['bytes 0-0/1']);
  });

  it('đủ byte → committing tới khi job ghi file xong (completed) mới done', async () => {
    for (const end of ['completed', 'failed'] as const) {
      const { s: srv, api } = fakeServer();
      const realChunk = api.chunk;
      api.chunk = async (...a) => {
        await realChunk(...a);
        if (srv.status === 'completed') srv.status = 'committing';
        return { ...srv, status: srv.status };
      };
      let polls = 0;
      api.status = async () => {
        polls += 1;
        if (polls === 2) srv.status = end;
        return { ...srv };
      };
      const states: string[] = [];
      const up = new Uploader(new Blob(['0123456789']), 'a.bin', api, (x) => states.push(x.state));
      up.pollMs = 0;
      await up.start();
      expect(states).toContain('committing');
      expect(polls).toBe(2);
      if (end === 'completed') expect(up.state).toBe('done');
      else {
        expect(up.state).toBe('error');
        expect(up.error).toBeInstanceOf(UploadCommitError);
      }
    }
  });
});
