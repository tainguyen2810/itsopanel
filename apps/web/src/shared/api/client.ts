/** Client tối thiểu cho scaffold. Phase 2/3 thay bằng type sinh từ OpenAPI (Prompt 1.7). */
export interface Health {
  status: 'ok';
}

export interface ComponentStatus {
  ok: boolean;
  latency_ms: number | null;
  error: string | null;
}

export interface SystemStatus {
  api: 'ok' | 'degraded';
  database: ComponentStatus;
  redis: ComponentStatus;
  agent: {
    reachable: boolean;
    mode: 'mock' | 'real' | null;
    version: string | null;
    latency_ms: number | null;
    error: string | null;
  };
  checked_at: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
}

export class ApiError extends Error {
  constructor(public readonly problem: Problem) {
    super(problem.title);
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      (body as Problem | null) ?? {
        type: 'about:blank',
        title: res.statusText,
        status: res.status,
        code: 'internal_error',
      },
    );
  }
  return (body as { data: T }).data;
}
