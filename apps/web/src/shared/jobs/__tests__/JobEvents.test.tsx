import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { JobDrawerHost, POLL_MS, type Job } from '../JobDrawer';
import { setJobDrawerOpen, watchJob } from '../jobStore';

// Prompt 11.6 (D-106): JobProgress nhận tiến độ qua SSE; SSE lỗi → poll 2 giây.

const job = (over: Partial<Job>): Job =>
  ({
    uuid: 'j1',
    type: 'website.update',
    state: 'running',
    progress: 10,
    resource: { type: 'website', uuid: 'w1' },
    steps: [
      { seq: 1, op: 'nginx.vhost.apply', state: 'running', started_at: null, finished_at: null },
      { seq: 2, op: 'nginx.reload', state: 'pending', started_at: null, finished_at: null },
    ],
    attempts: 1,
    max_attempts: 3,
    timeout_sec: 120,
    error: null,
    server: null,
    requested_by: null,
    created_at: '2026-11-21T08:00:00+07:00',
    started_at: null,
    finished_at: null,
    links: { self: '/api/v1/admin/jobs/j1', events: '/api/v1/admin/jobs/j1/events' },
    ...over,
  }) as Job;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent<string>) => void)[]>();
  constructor(
    public url: string,
    public init?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== fn),
    );
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data: unknown) {
    this.readyState = 1;
    for (const fn of this.listeners.get(type) ?? [])
      fn(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
  fail() {
    this.onerror?.();
  }
}

describe('JobDrawerHost + SSE', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    act(() => setJobDrawerOpen(false));
  });

  it('sự kiện SSE cập nhật tiến độ, không poll khi luồng đang chạy, đóng luồng khi job xong', async () => {
    const fetchJob = vi.fn(() => Promise.resolve(job({})));
    renderWithProviders(<JobDrawerHost fetchJob={fetchJob} />);
    act(() => watchJob('j1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe('/api/v1/admin/jobs/j1/events');
    expect(es.init?.withCredentials).toBe(true);
    act(() =>
      es.emit(
        'job',
        job({
          progress: 50,
          steps: [
            {
              seq: 1,
              op: 'nginx.vhost.apply',
              state: 'succeeded',
              started_at: null,
              finished_at: null,
            },
            { seq: 2, op: 'nginx.reload', state: 'running', started_at: null, finished_at: null },
          ],
        }),
      ),
    );
    await waitFor(() => expect(screen.getAllByText(/nginx|Nginx/).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, POLL_MS + 300));
    expect(fetchJob).toHaveBeenCalledTimes(1);
    act(() => es.emit('job', job({ state: 'succeeded', progress: 100 })));
    await waitFor(() => expect(es.readyState).toBe(2));
  }, 10_000);

  it('SSE lỗi lặp lại → quay về poll 2 giây', async () => {
    let n = 0;
    const fetchJob = vi.fn(() => Promise.resolve(job({ progress: ++n * 10 })));
    renderWithProviders(<JobDrawerHost fetchJob={fetchJob} />);
    act(() => watchJob('j1'));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0]!;
    act(() => {
      es.fail();
      es.fail();
    });
    expect(es.readyState).toBe(2);
    await waitFor(() => expect(fetchJob.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: POLL_MS + 1500,
    });
  }, 10_000);

  it('trình duyệt không có EventSource → poll', async () => {
    vi.stubGlobal('EventSource', undefined);
    const fetchJob = vi.fn(() => Promise.resolve(job({})));
    renderWithProviders(<JobDrawerHost fetchJob={fetchJob} />);
    act(() => watchJob('j1'));
    await waitFor(() => expect(fetchJob.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: POLL_MS + 1500,
    });
    expect(FakeEventSource.instances).toHaveLength(0);
  }, 10_000);
});
