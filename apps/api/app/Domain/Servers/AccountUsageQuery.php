<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Domain\Hosting\QuotaService;
use App\Models\HostingAccount;
use App\Models\Server;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * Số liệu gần nhất theo account trên một server (schema AccountUsageRow), đọc mẫu mới nhất của từng account × metric
 * trong metric_samples (ghi bởi `itso:usage-refresh` mỗi 5 phút từ metrics.cgroup + quota.report), D-101.
 */
final class AccountUsageQuery
{
    /** Mẫu cũ hơn ngưỡng này coi như không có (account chưa chạy hoặc agent mất kết nối). */
    public const FRESH_MINUTES = 30;

    private const METRICS = ['cpu_pct', 'ram_mb', 'io_read', 'io_write', 'tasks', 'disk_mb'];

    public function __construct(private readonly QuotaService $quota) {}

    /**
     * @param  Collection<int, HostingAccount>  $accounts  account trên server (đã lọc phạm vi)
     * @return list<array<string, mixed>>
     */
    public function rows(Server $server, Collection $accounts): array
    {
        $latest = $this->latest($server->id, array_values($accounts->map(fn (HostingAccount $a): int => $a->id)->all()));
        $rows = [];
        foreach ($accounts as $a) {
            $v = $latest[$a->id] ?? [];
            $l = $this->quota->limits($a);
            $at = $v['_at'] ?? null;
            $rows[] = [
                'hosting_account' => ['uuid' => $a->uuid, 'username' => $a->username],
                'server' => ['uuid' => $server->uuid, 'name' => $server->name],
                'cpu_pct' => round((float) ($v['cpu_pct'] ?? 0), 1),
                'ram_mb' => (float) ($v['ram_mb'] ?? 0),
                'ram_limit_mb' => (int) $l['ram_mb'] > 0 ? (float) $l['ram_mb'] : null,
                'io_read_bps' => (float) ($v['io_read'] ?? 0),
                'io_write_bps' => (float) ($v['io_write'] ?? 0),
                'tasks' => (int) ($v['tasks'] ?? 0),
                'disk_mb' => (float) ($v['disk_mb'] ?? 0),
                'disk_limit_mb' => (int) $l['disk_mb'] > 0 ? (float) $l['disk_mb'] : null,
                'sampled_at' => $at !== null ? Carbon::parse($at)->setTimezone(config('app.timezone'))->toIso8601String() : null,
            ];
        }

        return $rows;
    }

    /**
     * @param  list<int>  $accountIds
     * @return array<int, array<string, float|string>>
     */
    private function latest(int $serverId, array $accountIds): array
    {
        if ($accountIds === []) {
            return [];
        }
        $rows = DB::table('metric_samples')
            ->selectRaw('DISTINCT ON (hosting_account_id, metric) hosting_account_id, metric, value, at')
            ->where('server_id', $serverId)->whereIn('hosting_account_id', $accountIds)->whereIn('metric', self::METRICS)
            ->where('at', '>=', Carbon::now()->subMinutes(self::FRESH_MINUTES))
            ->orderBy('hosting_account_id')->orderBy('metric')->orderByDesc('at')->get();
        $out = [];
        foreach ($rows as $r) {
            $id = (int) $r->hosting_account_id;
            $out[$id][(string) $r->metric] = (float) $r->value;
            $at = (string) $r->at;
            if (! isset($out[$id]['_at']) || $at > (string) $out[$id]['_at']) {
                $out[$id]['_at'] = $at;
            }
        }

        return $out;
    }
}
