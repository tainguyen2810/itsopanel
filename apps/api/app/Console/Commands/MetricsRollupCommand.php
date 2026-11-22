<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Servers\MetricsRollup;
use Illuminate\Console\Command;

/** Gộp metric_samples → metric_rollups theo giờ (D-101). Lịch: mỗi giờ; idempotent, tự chạy bù khi trễ. */
final class MetricsRollupCommand extends Command
{
    protected $signature = 'itso:metrics-rollup';

    protected $description = 'Gộp số liệu 1 phút thành rollup 1 giờ (min/avg/max), chạy bù các giờ còn thiếu';

    public function handle(MetricsRollup $rollup): int
    {
        $n = $rollup->run();
        $this->info("Đã gộp {$n} giờ.");

        return self::SUCCESS;
    }
}
