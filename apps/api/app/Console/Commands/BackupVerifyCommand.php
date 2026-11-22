<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Backup\BackupService;
use App\Exceptions\ApiProblem;
use App\Models\BackupRepository;
use App\Models\BackupSnapshot;
use App\Models\Job;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;

/**
 * Kiểm chứng định kỳ (D-87): mỗi repo "restic check --read-data-subset 5%" khi lần check cuối quá 7 ngày; restore test
 * (manifest sha256 + nạp DB tạm) snapshot mới nhất của repo khi chưa có snapshot nào được kiểm chứng trong 30 ngày.
 * Tối đa --limit job mỗi lượt; repo đang có tác vụ backup thì để lượt sau. Lịch: hằng ngày (routes/console.php).
 */
final class BackupVerifyCommand extends Command
{
    protected $signature = 'itso:backup-verify {--limit=20 : Số job tối đa mỗi lượt} {--dry-run : Chỉ liệt kê}';

    protected $description = 'Kiểm chứng backup định kỳ (check hằng tuần, restore test hằng tháng)';

    public function handle(BackupService $backups): int
    {
        $now = Carbon::now();
        $limit = max(1, (int) $this->option('limit'));
        $n = 0;
        $repos = BackupRepository::query()->whereNotNull('initialized_at')->where('snapshots_count', '>', 0)->orderBy('last_check_at')->get();
        foreach ($repos as $r) {
            if ($n >= $limit) {
                break;
            }
            if (! $r->destination->enabled || $this->busy($r)) {
                continue;
            }
            $latest = BackupSnapshot::query()->where('repository_id', $r->id)->orderByDesc('taken_at')->first();
            $verifiedRecently = BackupSnapshot::query()->where('repository_id', $r->id)->where('verified_at', '>=', $now->copy()->subDays(30))->exists();
            $label = $r->path;
            try {
                if ($latest instanceof BackupSnapshot && ! $verifiedRecently) {
                    $this->line("$label: restore test {$latest->restic_snapshot_id}");
                    if (! $this->option('dry-run')) {
                        $backups->verify(null, $latest);
                    }
                    $n++;
                } elseif ($r->last_check_at === null || $r->last_check_at->lt($now->copy()->subDays(7))) {
                    $this->line("$label: check 5%");
                    if (! $this->option('dry-run')) {
                        $backups->checkRepo($r, 5);
                    }
                    $n++;
                }
            } catch (ApiProblem $e) {
                $this->warn("$label: {$e->getMessage()}");
            }
        }
        $this->info("$n tác vụ kiểm chứng".($this->option('dry-run') ? ' (dry-run)' : '').'.');

        return self::SUCCESS;
    }

    private function busy(BackupRepository $r): bool
    {
        $res = $r->hosting_account_id !== null ? ['hosting_account', $r->hosting_account_id] : ['server', $r->server_id];

        return Job::query()->whereIn('type', BackupService::JOB_TYPES)->where('resource_type', $res[0])->where('resource_id', $res[1])
            ->whereIn('state', ['queued', 'running', 'cancel_requested', 'waiting_agent'])->exists();
    }
}
