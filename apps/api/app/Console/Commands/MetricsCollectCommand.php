<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Servers\MetricsCollector;
use App\Models\Server;
use Illuminate\Console\Command;

/**
 * Thu số liệu server gắn agent local qua agent (system.info, metrics.snapshot, service.status), ghi metric_samples,
 * server_services, server_capacity. Lịch: mỗi phút (routes/console.php). Dọn partition: `itso:metrics-prune` (Phase 11).
 */
final class MetricsCollectCommand extends Command
{
    protected $signature = 'itso:metrics-collect';

    protected $description = 'Thu số liệu server từ agent vào metric_samples / server_services / server_capacity';

    public function handle(MetricsCollector $collector): int
    {
        // Mọi server có agent (local hoặc node qua relay, Phase 9); node bị thu hồi/chưa enroll xong bị bỏ qua.
        $servers = Server::query()->whereHas('agent', fn ($q) => $q->whereNull('revoked_at')
            ->where(fn ($w) => $w->where('transport', 'local')->orWhere(fn ($m) => $m->where('transport', 'mtls')
                ->whereNotNull('hmac_key_encrypted'))))->orderBy('id')->get();
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

        return $failed > 0 && $failed === $servers->count() ? self::FAILURE : self::SUCCESS;
    }
}
