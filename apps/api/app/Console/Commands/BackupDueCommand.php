<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Backup\BackupService;
use App\Domain\Backup\PolicyService;
use App\Exceptions\ApiProblem;
use App\Models\BackupPolicy;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;

/**
 * Chạy các chính sách backup đến hạn (D-86): khóa Redis theo policy (không chạy chồng khi scheduler trùng), lần chạy
 * kế tiếp lệch một khoảng jitter cố định theo policy (0–299 giây) để các policy cùng lịch không dồn vào một phút.
 * Lịch: 5 phút một lần (routes/console.php).
 */
final class BackupDueCommand extends Command
{
    protected $signature = 'itso:backup-due {--dry-run : Chỉ liệt kê policy đến hạn}';

    protected $description = 'Chạy chính sách backup đến hạn';

    public function handle(BackupService $backups): int
    {
        $now = Carbon::now();
        $due = BackupPolicy::query()->where('enabled', true)->whereNotNull('next_run_at')->where('next_run_at', '<=', $now)->orderBy('next_run_at')->get();
        foreach ($due as $p) {
            if ($this->option('dry-run')) {
                $this->line("{$p->uuid} {$p->name} ({$p->schedule})");

                continue;
            }
            $lock = Cache::lock('itso:backup-policy:'.$p->uuid, 600);
            if (! $lock->get()) {
                $this->warn("{$p->name}: đang được chạy bởi tiến trình khác.");

                continue;
            }
            try {
                $p->forceFill(['next_run_at' => self::nextRun($p, $now)])->save();
                $jobs = $backups->runPolicy($p, null);
                $this->line("{$p->name}: ".count($jobs).' job.');
            } catch (ApiProblem $e) {
                $p->forceFill(['last_status' => 'failed', 'last_run_at' => $now])->save();
                $this->warn("{$p->name}: {$e->getMessage()}");
            } finally {
                $lock->release();
            }
        }
        $this->info($due->count().' policy đến hạn.');

        return self::SUCCESS;
    }

    public static function nextRun(BackupPolicy $p, Carbon $after): Carbon
    {
        return PolicyService::next($p->schedule, $after)->addSeconds(crc32($p->uuid) % 300);
    }
}
