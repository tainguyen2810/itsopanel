<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Hosting\QuotaService;
use App\Domain\Notifications\UserEvents;
use App\Domain\Servers\MetricsCollector;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\AccountUsageSnapshot;
use App\Models\HostingAccount;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;

/**
 * Đọc mức dùng (disk, inode, CPU, RAM) qua op quota.report, ghi account_usage_snapshots (bản mới nhất được
 * /hosting-accounts/{id}/usage đọc) và metric_samples theo account. Phase 11 (D-101): thêm một lần metrics.cgroup
 * chế độ lô cho mỗi server (mọi slice, không gọi theo từng account) → cpu_pct, ram, IO, tasks.
 * Metric account: cpu_pct (% một core, giới hạn gói cpu_percent), ram_pct/disk_pct/inode_pct (% giới hạn gói),
 * io_read/io_write (byte/giây), tasks; ram_mb/disk_mb là số tuyệt đối cho bảng top account.
 * Lịch: mỗi 5 phút (routes/console.php).
 */
final class UsageRefreshCommand extends Command
{
    protected $signature = 'itso:usage-refresh';

    protected $description = 'Cập nhật mức dùng của các hosting account từ agent (quota.report)';

    public function handle(AgentClient $agent, QuotaService $quota, MetricsCollector $metrics, UserEvents $events): int
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
            $cg = $this->cgroups($agent, (int) $serverId);
            foreach ($group as $a) {
                $u = $byUser->get($a->username);
                if (! is_array($u)) {
                    continue;
                }
                $c = $cg[$a->username] ?? null;
                $ramMb = $c !== null ? (int) ($c['memory_current_mb'] ?? 0) : (int) $u['ram_mb'];
                AccountUsageSnapshot::query()->create(['hosting_account_id' => $a->id, 'disk_mb' => (int) $u['disk_mb'],
                    'inode_count' => (int) $u['inodes'], 'mem_peak_mb' => $ramMb, 'at' => $now]);
                $l = $quota->limits($a);
                $pct = fn (int|float $used, int $limit): float => $limit > 0 ? round($used * 100 / $limit, 2) : 0.0;
                $samples = ['cpu_pct' => $c !== null ? (float) ($c['cpu_pct'] ?? 0) : (float) $u['cpu_pct'],
                    'ram_pct' => $pct($ramMb, (int) $l['ram_mb']), 'disk_pct' => $pct((int) $u['disk_mb'], (int) $l['disk_mb']),
                    'inode_pct' => $pct((int) $u['inodes'], (int) $l['inode_limit']),
                    'ram_mb' => $ramMb, 'disk_mb' => (int) $u['disk_mb']];
                if ($c !== null) {
                    $samples += ['io_read' => (float) ($c['io_read_bps'] ?? 0), 'io_write' => (float) ($c['io_write_bps'] ?? 0),
                        'tasks' => (int) ($c['pids_current'] ?? 0)];
                }
                $metrics->insertSamples($a->server_id, $a->id, $samples, $now);
                if ((int) $l['disk_mb'] > 0) {
                    $events->quota($a, (float) $samples['disk_pct']); // quota.warning 80 % / quota.exceeded 100 %
                }
                $n++;
            }
        }
        if ($failed > 0 && $n === 0) {
            return self::FAILURE;
        }
        $this->info("Đã ghi {$n} snapshot.");

        return self::SUCCESS;
    }

    /**
     * Một lần metrics.cgroup (accounts rỗng = mọi slice) cho server. Lỗi/agent cũ → rỗng (vẫn ghi số liệu quota.report).
     *
     * @return array<string, array<string, mixed>> theo username
     */
    private function cgroups(AgentClient $agent, int $serverId): array
    {
        try {
            $res = $agent->forServer($serverId)->call('metrics.cgroup', []);
        } catch (AgentUnavailable) {
            return [];
        }
        if (! $res->ok) {
            return [];
        }
        $out = [];
        foreach ((array) ($res->data['accounts'] ?? []) as $row) {
            if (is_array($row) && is_string($row['username'] ?? null)) {
                $out[$row['username']] = $row;
            }
        }

        return $out;
    }
}
