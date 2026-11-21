<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Data\CronService;
use App\Models\CronJob;
use App\Models\HostingAccount;
use Illuminate\Console\Command;

/** Ghi lần chạy cron theo lịch (trigger schedule) từ cron.inspect của agent (D-74). Lịch: mỗi 5 phút. */
final class CronSyncCommand extends Command
{
    protected $signature = 'itso:cron-sync {account? : Username account (mặc định: mọi account có cron)}';

    protected $description = 'Đồng bộ lịch sử chạy cron từ agent';

    public function handle(CronService $cron): int
    {
        $q = HostingAccount::query()->where('lifecycle_state', 'active')
            ->whereIn('id', CronJob::query()->select('hosting_account_id'))->orderBy('username');
        if (is_string($this->argument('account'))) {
            $q->where('username', $this->argument('account'));
        }
        $total = 0;
        foreach ($q->get() as $a) {
            $n = $cron->sync($a);
            $total += $n;
            if ($n > 0) {
                $this->line("{$a->username}: $n lần chạy mới");
            }
        }
        $this->info("Đã ghi $total lần chạy.");

        return self::SUCCESS;
    }
}
