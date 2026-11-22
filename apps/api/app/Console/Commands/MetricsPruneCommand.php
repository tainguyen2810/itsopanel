<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Servers\MetricsCollector;
use Illuminate\Console\Command;

/**
 * Bảo trì lưu trữ số liệu (D-101): tạo trước partition metric_samples 2 ngày tới, drop partition quá 7 ngày
 * (không DELETE từng dòng), xóa rollup quá 90 ngày. Lịch: hằng ngày.
 */
final class MetricsPruneCommand extends Command
{
    protected $signature = 'itso:metrics-prune';

    protected $description = 'Tạo trước partition, drop partition metric_samples cũ, xóa rollup quá hạn';

    public function handle(MetricsCollector $collector): int
    {
        $collector->ensureAhead();
        $parts = $collector->prune();
        $rollups = $collector->pruneRollups();
        $this->info("Đã drop {$parts} partition metric_samples, xóa {$rollups} rollup cũ.");

        return self::SUCCESS;
    }
}
