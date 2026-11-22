<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Monitoring\UptimeService;
use App\Domain\Servers\MetricsRollup;
use Illuminate\Console\Command;

/** Gộp metric_samples → metric_rollups và uptime_results → uptime_rollups theo giờ (D-101, D-105). Lịch: mỗi giờ; idempotent, tự chạy bù khi trễ. */
final class MetricsRollupCommand extends Command
{
    protected $signature = 'itso:metrics-rollup';

    protected $description = 'Gộp số liệu 1 phút thành rollup 1 giờ (min/avg/max), chạy bù các giờ còn thiếu';

    public function handle(MetricsRollup $rollup, UptimeService $uptime): int
    {
        $n = $rollup->run();
        $u = $uptime->rollup();
        $this->info("Đã gộp {$n} giờ số liệu, {$u} giờ uptime.");

        return self::SUCCESS;
    }
}
