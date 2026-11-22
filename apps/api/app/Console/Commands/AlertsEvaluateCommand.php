<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Monitoring\AlertEngine;
use Illuminate\Console\Command;

/** Đánh giá rule cảnh báo (D-102, ADR 0047). Lịch: mỗi phút, withoutOverlapping. */
final class AlertsEvaluateCommand extends Command
{
    protected $signature = 'itso:alerts-evaluate';

    protected $description = 'Đánh giá rule cảnh báo: pending → firing → resolved, nhắc lại, thông báo';

    public function handle(AlertEngine $engine): int
    {
        $s = $engine->evaluate();
        $this->info("{$s['rules']} rule, {$s['firing']} chuyển firing, {$s['resolved']} resolved, {$s['notified']} thông báo.");

        return self::SUCCESS;
    }
}
