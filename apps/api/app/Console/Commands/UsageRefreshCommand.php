<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Hosting\QuotaService;
use App\Domain\Servers\MetricsCollector;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\AccountUsageSnapshot;
use App\Models\HostingAccount;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;

/**
 * Đọc mức dùng (disk, inode, CPU, RAM) qua op quota.report, ghi account_usage_snapshots (bản mới nhất được
 * /hosting-accounts/{id}/usage đọc) và metric_samples theo account (cpu_pct, ram_pct, disk_pct).
 * Lịch: mỗi 5 phút (routes/console.php).
 */
final class UsageRefreshCommand extends Command
{
    protected $signature = 'itso:usage-refresh';

    protected $description = 'Cập nhật mức dùng của các hosting account từ agent (quota.report)';

    public function handle(AgentClient $agent, QuotaService $quota, MetricsCollector $metrics): int
    {
        $accounts = HostingAccount::query()->whereIn('lifecycle_state', ['active', 'suspended'])->orderBy('id')->get();
        if ($accounts->isEmpty()) {
            $this->info('Không có account active/suspended.');

            return self::SUCCESS;
        }
        $now = Carbon::now();
        $n = 0;
        $failed = 0;
        // Mỗi server một lần quota.report qua kênh của server đó (local hoặc relay, Phase 9).
        foreach ($accounts->groupBy('server_id') as $serverId => $group) {
            try {
                $res = $agent->forServer((int) $serverId)->call('quota.report', ['accounts' => $group->map(fn (HostingAccount $a): array => [
                    'username' => $a->username, 'uid' => $a->uid])->values()->all()]);
            } catch (AgentUnavailable $e) {
                $this->error("server {$serverId}: ".$e->getMessage());
                $failed++;

                continue;
            }
            if (! $res->ok) {
                $this->error("server {$serverId}: quota.report lỗi: ".($res->error['message'] ?? ''));
                $failed++;

                continue;
            }
            $byUser = collect((array) ($res->data['usage'] ?? []))->keyBy('username');
            foreach ($group as $a) {
                $u = $byUser->get($a->username);
                if (! is_array($u)) {
                    continue;
                }
                AccountUsageSnapshot::query()->create(['hosting_account_id' => $a->id, 'disk_mb' => (int) $u['disk_mb'],
                    'inode_count' => (int) $u['inodes'], 'mem_peak_mb' => (int) $u['ram_mb'], 'at' => $now]);
                $l = $quota->limits($a);
                $pct = fn (int|float $used, int $limit): float => $limit > 0 ? round($used * 100 / $limit, 2) : 0.0;
                $metrics->insertSamples($a->server_id, $a->id, ['cpu_pct' => (float) $u['cpu_pct'],
                    'ram_pct' => $pct((int) $u['ram_mb'], (int) $l['ram_mb']), 'disk_pct' => $pct((int) $u['disk_mb'], (int) $l['disk_mb'])], $now);
                $n++;
            }
        }
        if ($failed > 0 && $n === 0) {
            return self::FAILURE;
        }
        $this->info("Đã ghi {$n} snapshot.");

        return self::SUCCESS;
    }
}
