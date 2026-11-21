/**
 * Mã lỗi job (agent-ops/errors.json và bước panel) có lời giải thích dễ hiểu (common:jobErrors.*).
 * Mã khác chỉ hiện thông báo kỹ thuật của job.
 */
export const EXPLAINED_JOB_ERRORS = [
  'config_test_failed',
  'precondition_failed',
  'invalid_params',
  'dependency_unavailable',
  'agent_unavailable',
  'quota_exceeded',
  'busy',
  'deadline_exceeded',
  'timed_out',
  'already_exists',
  'not_found',
  'internal',
] as const;
export type ExplainedJobError = (typeof EXPLAINED_JOB_ERRORS)[number];

/** Mã lỗi có lời giải thích, hoặc null. */
export function explainJobError(code: string | null | undefined): ExplainedJobError | null {
  return code && (EXPLAINED_JOB_ERRORS as readonly string[]).includes(code)
    ? (code as ExplainedJobError)
    : null;
}

/** Tài nguyên tính theo gói (QuotaService::COUNTED và đo dung lượng) có tên hiển thị. */
export const QUOTA_RESOURCES = [
  'websites',
  'databases',
  'ftp_accounts',
  'cron_jobs',
  'disk_mb',
  'inodes',
] as const;

/** Tài nguyên vượt gói từ `errors` của Problem quota_exceeded (khóa đầu tiên), hoặc null. */
export function quotaResource(errors: unknown): string | null {
  if (!errors || typeof errors !== 'object') return null;
  const k = Object.keys(errors)[0];
  return k && (QUOTA_RESOURCES as readonly string[]).includes(k) ? k : null;
}
