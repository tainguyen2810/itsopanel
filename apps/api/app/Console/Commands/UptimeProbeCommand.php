<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Monitoring\UptimeService;
use Illuminate\Console\Command;

/**
 * Gọi uptime check đến hạn qua op uptime.probe, gom theo server (D-105). Lịch: mỗi phút.
 * `--all`: kiểm ngay mọi check đang bật, bỏ qua interval (vận hành/e2e kiểm lại sau khi sửa site).
 */
final class UptimeProbeCommand extends Command
{
    protected $signature = 'itso:uptime-probe {--all : Kiểm mọi check đang bật, không chờ đến hạn}';

    protected $description = 'Kiểm uptime website đến hạn qua agent của server chứa website';

    public function handle(UptimeService $uptime): int
    {
        $r = $uptime->probeDue(null, (bool) $this->option('all'));
        $this->info("Đã kiểm {$r['checked']} website; {$r['failed_servers']} server không trả lời.");

        return self::SUCCESS;
    }
}
