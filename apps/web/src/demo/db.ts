import type { components as A } from '@/api/generated/admin/schema';
import { dataset, type DemoData } from './dataset';

type S = A['schemas'];
export type Job = S['Job'];
export type JobStep = Job['steps'][number];
export type ResourceType = NonNullable<Job['resource']>['type'];

/** Thời gian mỗi bước job giả lập (ms). Test đặt nhỏ để chạy nhanh. */
let stepMs = 900;
export function setStepMs(ms: number) {
  stepMs = ms;
}

interface PendingJob {
  uuid: string;
  createdAt: number;
  /** Bước (0-based) sẽ thất bại, nếu có. */
  failAt?: number;
  onDone?: (db: DemoDb) => void;
}

/** CSDL trong bộ nhớ cho chế độ demo: bản sao dữ liệu demo, có thể ghi; job chạy theo thời gian. */
export class DemoDb {
  data: DemoData;
  private pending = new Map<string, PendingJob>();
  private seq = 1000;

  constructor() {
    this.data = structuredClone(dataset);
  }

  list<K extends keyof DemoData>(name: K): DemoData[K] {
    return this.data[name];
  }

  /** UUID v7 dạng đọc được cho bản ghi mới (cùng quy ước contracts/tools/demo.py, kind 0xfe). */
  newUuid(): string {
    this.seq += 1;
    const n = this.seq.toString(16).padStart(4, '0');
    return `01938afe-${n}-7000-8000-0000fe00${n}`;
  }

  now(): string {
    return toIso(new Date());
  }

  /** Tạo job mới với các bước theo op agent; trạng thái tiến triển theo thời gian (xem tick). */
  createJob(opts: {
    type: string;
    resource: { type: ResourceType; uuid: string };
    ops: string[];
    server?: { uuid: string; name: string } | null;
    requestedBy: { uuid: string; name: string; email: string };
    failAt?: number;
    onDone?: (db: DemoDb) => void;
  }): Job {
    const uuid = this.newUuid();
    const at = this.now();
    const job: Job = {
      uuid,
      type: opts.type,
      state: 'queued',
      progress: 0,
      resource: opts.resource,
      steps: opts.ops.map((op, i) => ({
        seq: i + 1,
        op,
        state: 'pending',
        started_at: null,
        finished_at: null,
      })),
      attempts: 0,
      max_attempts: 3,
      timeout_sec: 600,
      error: null,
      server: opts.server ?? null,
      requested_by: opts.requestedBy,
      created_at: at,
      started_at: null,
      finished_at: null,
      links: { self: `/api/v1/admin/jobs/${uuid}`, events: `/api/v1/admin/jobs/${uuid}/events` },
    } as Job;
    this.data.jobs.unshift(job);
    this.pending.set(uuid, {
      uuid,
      createdAt: Date.now(),
      ...(opts.failAt === undefined ? {} : { failAt: opts.failAt }),
      ...(opts.onDone ? { onDone: opts.onDone } : {}),
    });
    return job;
  }

  /** Cập nhật mọi job đang chạy theo thời gian đã trôi; gọi trước mỗi request. */
  tick() {
    const now = Date.now();
    for (const p of [...this.pending.values()]) {
      const job = this.data.jobs.find((j) => j.uuid === p.uuid);
      if (!job) {
        this.pending.delete(p.uuid);
        continue;
      }
      if (job.state === 'cancelled' || job.state === 'cancel_requested') {
        job.state = 'cancelled';
        job.finished_at = this.now();
        for (const s of job.steps)
          if (s.state === 'pending' || s.state === 'running') s.state = 'skipped';
        this.pending.delete(p.uuid);
        continue;
      }
      const elapsed = now - p.createdAt;
      const n = job.steps.length;
      // Bước i chạy trong [ (i+0.3)·T, (i+1.3)·T ): 0,3·T đầu là thời gian xếp hàng.
      const pos = elapsed / stepMs - 0.3;
      const iso = this.now();
      if (pos < 0) continue;
      job.state = 'running';
      job.attempts = 1;
      job.started_at ??= iso;
      for (let i = 0; i < n; i++) {
        const s = job.steps[i] as JobStep;
        if (p.failAt === i && pos >= i + 0.5) {
          s.state = 'failed';
          s.started_at ??= iso;
          s.finished_at = iso;
          for (const rest of job.steps.slice(i + 1)) rest.state = 'skipped';
          job.state = 'failed';
          job.error = {
            code: 'job_failed',
            message: `Bước ${s.op} thất bại (giả lập)`,
            step: s.seq,
          };
          job.finished_at = iso;
          job.progress = Math.round((i * 100) / n);
          this.pending.delete(p.uuid);
          break;
        }
        if (pos >= i + 1) {
          s.state = 'succeeded';
          s.started_at ??= iso;
          s.finished_at ??= iso;
        } else if (pos >= i) {
          s.state = 'running';
          s.started_at ??= iso;
        }
      }
      if (job.state === 'failed') continue;
      const done = job.steps.filter((s) => s.state === 'succeeded').length;
      job.progress = Math.round((done * 100) / n);
      if (done === n) {
        job.state = 'succeeded';
        job.finished_at = iso;
        this.pending.delete(p.uuid);
        p.onDone?.(this);
      }
    }
  }
}

/** ISO 8601 theo múi giờ +07:00 (như dữ liệu demo). */
export function toIso(d: Date): string {
  const t = new Date(d.getTime() + 7 * 3600_000);
  return t.toISOString().replace(/\.\d{3}Z$/, '+07:00');
}

let instance: DemoDb | null = null;
export function db(): DemoDb {
  instance ??= new DemoDb();
  return instance;
}
/** Test: làm mới dữ liệu. */
export function resetDb() {
  instance = new DemoDb();
  return instance;
}
