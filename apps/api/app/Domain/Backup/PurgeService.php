<?php

declare(strict_types=1);

namespace App\Domain\Backup;

use App\Domain\Audit\AuditLogger;
use App\Domain\Data\DataSpec;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Models\BackupSnapshot;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\PurgeRecord;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Cổng purge (D-46, Prompt 8.4): account đã chấm dứt → lên lịch (biên bản + backup cuối có tag "final" → tự kiểm chứng:
 * restic check + restore test) → xác nhận (gõ username) chỉ khi snapshot cuối đã kiểm chứng, đã tới hạn giữ dữ liệu
 * không có legal hold, và người xác nhận khác người lên lịch (trigger DB itso_hosting_purge_guard kiểm lại). Xóa thật do op agent "account.remove" (rủi ro critical).
 */
final class PurgeService
{
    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit,
        private readonly BackupService $backups) {}

    public function schedule(User $actor, HostingAccount $a, bool $finalBackup, ?string $note): Job
    {
        if ($a->lifecycle_state !== 'terminated') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Chưa chấm dứt account', 'Chỉ purge account đã chấm dứt (terminate) và hết thời gian giữ dữ liệu.');
        }
        if ($a->legal_hold) {
            throw new ApiProblem(409, 'precondition_failed', 'Đang legal hold', 'Account đang bị giữ theo yêu cầu pháp lý: không purge.');
        }
        $snap = null;
        if (! $finalBackup) {
            // Không chạy backup mới: dùng snapshot files mới nhất của account, vẫn phải kiểm chứng lại.
            $snap = BackupSnapshot::query()->where('hosting_account_id', $a->id)->where('scope_type', 'hosting_account')->orderByDesc('taken_at')->first();
            if (! $snap instanceof BackupSnapshot) {
                throw ApiProblem::field('final_backup', 'Account chưa có snapshot nào: cần backup cuối (final_backup = true).');
            }
        }
        $this->backups->ensureIdle($a);

        return DB::transaction(function () use ($actor, $a, $finalBackup, $note, $snap): Job {
            PurgeRecord::query()->where('hosting_account_id', $a->id)->whereNull('completed_at')->delete(); // biên bản cũ chưa xong bị thay
            $pr = PurgeRecord::query()->create(['hosting_account_id' => $a->id, 'requested_by_user_id' => $actor->id,
                'final_backup_snapshot_id' => $snap?->id, 'scheduled_for' => $a->purge_after !== null && $a->purge_after->isFuture() ? $a->purge_after : Carbon::now(),
                'objects' => []]);
            $job = $finalBackup ? $this->backups->backupNow($actor, $a, ['files', 'databases'], $note, true)
                : $this->backups->verify($actor, $snap);
            $this->audit->record('hosting_account.schedule_purge', $a, ['purge' => $pr->uuid, 'final_backup' => $finalBackup, 'note' => $note,
                'scheduled_for' => $pr->scheduled_for->toIso8601String()], 'success', $a->server_id, $job->id, $actor);

            return $job;
        });
    }

    public function confirm(User $actor, HostingAccount $a, string $purgeUuid, string $username): Job
    {
        $pr = PurgeRecord::query()->where('uuid', $purgeUuid)->where('hosting_account_id', $a->id)->first();
        if (! $pr instanceof PurgeRecord || $pr->completed_at !== null) {
            throw ApiProblem::field('purge_uuid', 'Không có biên bản purge đang mở cho account này.');
        }
        if ($username !== $a->username) {
            throw ApiProblem::field('confirm_username', 'Gõ đúng username account để xác nhận purge.');
        }
        if ($a->lifecycle_state !== 'terminated' || $a->legal_hold) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Không purge được', $a->legal_hold ? 'Account đang legal hold.' : "Account đang {$a->lifecycle_state}.");
        }
        $snap = $pr->final_backup_snapshot_id !== null ? BackupSnapshot::query()->find($pr->final_backup_snapshot_id) : null;
        if (! $snap instanceof BackupSnapshot || $pr->backup_verified_at === null) {
            $this->audit->record('hosting_account.confirm_purge', $a, ['purge' => $pr->uuid, 'reason' => 'backup_not_verified'], 'denied',
                $a->server_id, null, $actor);
            throw new ApiProblem(409, 'precondition_failed', 'Chưa có backup cuối đã kiểm chứng',
                'Purge bị chặn: backup cuối phải qua restic check và restore test trước (D-46). Xem tiến độ ở Jobs.');
        }
        if ($pr->scheduled_for->isFuture() || ($a->purge_after !== null && $a->purge_after->isFuture())) {
            throw new ApiProblem(409, 'precondition_failed', 'Chưa tới hạn purge', 'Dữ liệu còn được giữ tới '.$pr->scheduled_for->toIso8601String().'.');
        }
        if ($pr->requested_by_user_id === $actor->id) {
            throw new ApiProblem(409, 'precondition_failed', 'Cần người xác nhận thứ hai',
                'Purge 2 bước (D-46): người lên lịch không tự xác nhận; một SUPER_ADMIN khác phải xác nhận.');
        }
        $this->backups->ensureIdle($a);

        return DB::transaction(function () use ($actor, $a, $pr, $snap): Job {
            $pr->forceFill(['confirmed_by_user_id' => $actor->id])->save();
            $spec = (new JobSpec('hosting_account.purge', $a, $a->server_id, 1, 1800))
                ->step('account.remove', ['account' => DataSpec::acct($a), 'reason' => 'purge', 'ref_uuid' => $pr->uuid,
                    'final_snapshot_id' => $snap->restic_snapshot_id, 'confirm_username' => $a->username, 'confirm' => true]);
            $job = $this->jobs->dispatch($spec, $actor);
            $this->audit->record('hosting_account.confirm_purge', $a, ['purge' => $pr->uuid, 'final_snapshot' => $snap->uuid], 'success',
                $a->server_id, $job->id, $actor);

            return $job;
        });
    }
}
