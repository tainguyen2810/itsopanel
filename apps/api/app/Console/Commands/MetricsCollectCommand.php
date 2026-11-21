<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Servers\MetricsCollector;
use App\Models\Server;
use Illuminate\Console\Command;

/**
 * Thu số liệu server gắn agent local qua agent (system.info, metrics.snapshot, service.status), ghi metric_samples,
 * server_services, server_capacity; dọn partition metric_samples quá 7 ngày. Lịch: mỗi phút (routes/console.php).
 */
final class MetricsCollectCommand extends Command
{
    protected $signature = 'itso:metrics-collect {--no-prune : Không dọn partition cũ}';

    protected $description = 'Thu số liệu server từ agent vào metric_samples / server_services / server_capacity';

    public function handle(MetricsCollector $collector): int
    {
        // Phase 4: một agent local (AgentClient một kết nối). Server agent từ xa: Phase 9.
        $servers = Server::query()->whereHas('agent', fn ($q) => $q->where('transport', 'local'))->orderBy('id')->get();
        if ($servers->isEmpty()) {
            $this->warn('Chưa có server gắn agent local (chạy: php artisan itso:server-local).');
        }
        $failed = 0;
        foreach ($servers as $s) {
            $r = $collector->collect($s);
            if (! $r['facts']) {
                $failed++;
                $this->warn("{$s->name}: agent không trả lời (trạng thái {$s->refresh()->status}).");

                continue;
            }
            $this->info(sprintf('%s: metrics %s, %d dịch vụ', $s->name, $r['metrics'] ? 'ok' : 'thiếu', $r['services']));
        }
        if ($this->option('no-prune') !== true) {
            $n = $collector->prune();
            if ($n > 0) {
                $this->info("Đã xóa {$n} partition metric_samples cũ.");
            }
        }

        return $failed > 0 && $failed === $servers->count() ? self::FAILURE : self::SUCCESS;
    }
}
