<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Migration\MigrationService;
use App\Exceptions\ApiProblem;
use App\Models\AccountMigration;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;

/** Dọn server nguồn của các lượt chuyển đã qua hạn giữ nguồn (ADR 0038 §2: "hoặc tới hạn"). Lịch: mỗi giờ. */
final class MigrationsCleanupCommand extends Command
{
    protected $signature = 'itso:migrations-cleanup';

    protected $description = 'Dọn server nguồn (account.remove reason=migrated) cho lượt chuyển account đã qua hạn giữ nguồn';

    public function handle(MigrationService $svc): int
    {
        $n = 0;
        foreach (AccountMigration::query()->where('state', 'holding')->where('cleanup_after', '<=', Carbon::now())->orderBy('id')->get() as $m) {
            try {
                $svc->cleanup(null, $m, null, false);
                $n++;
            } catch (ApiProblem $e) {
                $this->warn("{$m->uuid}: {$e->getMessage()}");
            }
        }
        $this->info("$n lượt chuyển được dọn nguồn");

        return self::SUCCESS;
    }
}
