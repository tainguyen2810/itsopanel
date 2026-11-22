<?php

declare(strict_types=1);

namespace App\Domain\Migration;

use App\Domain\Backup\BackupJobHandler;
use App\Domain\Jobs\JobHandler;
use App\Models\AccountMigration;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\User;

/**
 * Nối các chặng của lượt chuyển account (MigrationService): chặng xong → cập nhật trạng thái + tạo job chặng sau;
 * chặng lỗi → lượt chuyển `failed` (trước cutover: account hoạt động lại ngay; từ cutover: chờ admin hoàn tác).
 * Chặng có bước backup ở nguồn được ghi nhận như job backup thường (snapshot, repo init, thống kê).
 */
final class MigrationJobHandler implements JobHandler
{
    public function __construct(private readonly MigrationService $svc, private readonly BackupJobHandler $backup) {}

    public function succeeded(Job $job): void
    {
        $m = $this->migration($job);
        if (! $m instanceof AccountMigration) {
            return;
        }
        $actor = $job->requested_by_user_id !== null ? User::query()->find($job->requested_by_user_id) : null;
        switch ($job->type) {
            case 'hosting_account.migrate':
                $this->backup->succeeded($job);
                [$files, $dbs, $bytes] = $this->snapshots($job);
                $m->forceFill(['sync_snapshot_id' => $files, 'bytes_synced' => $bytes])->save();
                $next = $this->svc->dispatchSync($m, (string) $files, $dbs, $actor);
                $m->forceFill(['job_id' => $next->id])->save();
                break;
            case 'migration.sync':
                $checks = $this->verification($job);
                $bad = collect($checks)->where('ok', false)->pluck('name')->implode(', ');
                $m->forceFill(['state' => 'verifying', 'verification' => $checks,
                    'error' => $bad !== '' ? 'Kiểm chứng lệch: '.$bad.' (không cutover được; hoàn tác hoặc chuyển lại).' : null])->save();
                break;
            case 'migration.cutover':
                $this->backup->succeeded($job);
                [$files, $dbs] = $this->snapshots($job);
                $m->forceFill(['final_snapshot_id' => $files])->save();
                $next = $this->svc->dispatchCutoverTarget($m, (string) $files, $dbs, $actor);
                $m->forceFill(['job_id' => $next->id])->save();
                break;
            case 'migration.cutover_target':
                $checks = $this->verification($job);
                $m->forceFill(['verification' => $checks ?: $m->verification])->save();
                $this->svc->completeCutover($m);
                break;
            case 'migration.rollback':
                $next = $this->svc->dispatchRollbackSource($m, $actor);
                $m->forceFill(['job_id' => $next->id])->save();
                break;
            case 'migration.rollback_source':
                $this->svc->completeRollback($m);
                break;
            case 'migration.cleanup':
                $this->svc->completeCleanup($m);
                break;
        }
    }

    public function failed(Job $job): void
    {
        $m = $this->migration($job);
        if (! $m instanceof AccountMigration) {
            return;
        }
        if (in_array($job->type, ['hosting_account.migrate', 'migration.cutover'], true)) {
            $this->backup->failed($job);
        }
        $msg = trim(($job->error_code ? "[{$job->error_code}] " : '').(string) $job->error_message);
        if ($job->type === 'migration.sync') {
            $m->forceFill(['verification' => $this->verification($job)])->save();
        }
        // Dọn nguồn lỗi: vẫn đang giữ nguồn, chạy lại được; hoàn tác lỗi: giữ trạng thái để thử lại.
        if (in_array($job->type, ['migration.cleanup', 'migration.rollback', 'migration.rollback_source'], true)) {
            $m->forceFill(['error' => mb_substr('Chặng '.$job->type.' lỗi: '.$msg, 0, 1000)])->save();

            return;
        }
        $this->svc->fail($m, 'Chặng '.$job->type.' lỗi: '.$msg);
    }

    private function migration(Job $job): ?AccountMigration
    {
        return $job->resource_type === 'account_migration' && $job->resource_id !== null
            ? AccountMigration::query()->lockForUpdate()->find($job->resource_id) : null;
    }

    /** @return array{0: string|null, 1: array<string, string>, 2: int} snapshot files, snapshot từng DB, tổng byte */
    private function snapshots(Job $job): array
    {
        $files = null;
        $dbs = [];
        $bytes = 0;
        foreach (JobStep::query()->where('job_id', $job->id)->where('op', 'backup.run')->where('state', 'succeeded')->orderBy('seq')->get() as $st) {
            $sid = $st->result['snapshot_id'] ?? null;
            if (! is_string($sid)) {
                continue;
            }
            $bytes += (int) ($st->result['size_bytes'] ?? 0);
            if (($st->params_redacted['kind'] ?? '') === 'files') {
                $files = $sid;
            } else {
                foreach ((array) ($st->params_redacted['databases'] ?? []) as $d) {
                    $dbs[(string) $d['name']] = $sid;
                }
            }
        }

        return [$files, $dbs, $bytes];
    }

    /** @return list<array{kind: string, name: string, ok: bool, detail: string}> */
    private function verification(Job $job): array
    {
        $st = JobStep::query()->where('job_id', $job->id)->where('op', 'migrate.verify')->where('state', 'succeeded')->orderByDesc('seq')->first();
        $out = [];
        foreach ((array) ($st?->result['checks'] ?? []) as $c) {
            $out[] = ['kind' => (string) $c['kind'], 'name' => (string) $c['name'], 'ok' => (bool) $c['ok'], 'detail' => (string) $c['detail']];
        }
        foreach (JobStep::query()->where('job_id', $job->id)->where('op', 'http.check')->where('state', 'succeeded')->orderBy('seq')->get() as $h) {
            $out[] = ['kind' => 'http', 'name' => (string) ($h->params_redacted['host'] ?? ''), 'ok' => (bool) ($h->result['ok'] ?? false),
                'detail' => 'HTTP '.(int) ($h->result['status'] ?? 0).' sau cutover (127.0.0.1 của server đích)'];
        }

        return $out;
    }
}
