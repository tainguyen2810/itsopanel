<?php

declare(strict_types=1);

namespace App\Domain\Monitoring;

use App\Domain\Servers\MetricsCollector;
use App\Models\AlertRule;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Nguồn số liệu cho rule cảnh báo (D-102): mẫu mới nhất của metric_samples, kết nối agent, dịch vụ, uptime,
 * chứng chỉ, backup, quota. Trả về đối tượng trong phạm vi rule kèm giá trị hiện tại (null = không có số liệu).
 */
final class AlertMetrics
{
    /** metric → phạm vi hỗ trợ */
    public const CATALOG = [
        'cpu_pct' => ['server', 'hosting_account'],
        'ram_pct' => ['server', 'hosting_account'],
        'disk_pct' => ['server'],
        'swap_pct' => ['server'],
        'inode_pct' => ['server', 'hosting_account'],
        'load_1m' => ['server'],
        'agent_offline_sec' => ['server'],
        'service_down' => ['server'],
        'quota_disk_pct' => ['hosting_account'],
        'backup_failed' => ['hosting_account'],
        'uptime_down' => ['website'],
        'cert_days' => ['website'],
        'http_latency_ms' => ['website'],
        'http_status' => ['website'],
    ];

    /** Nhãn hiển thị trong nội dung cảnh báo (không chứa bí mật). */
    public const LABELS = [
        'cpu_pct' => 'CPU', 'ram_pct' => 'RAM', 'disk_pct' => 'Disk', 'swap_pct' => 'Swap', 'inode_pct' => 'Inode',
        'load_1m' => 'Load', 'agent_offline_sec' => 'Mất kết nối agent (giây)', 'service_down' => 'Dịch vụ lõi dừng',
        'quota_disk_pct' => 'Quota disk', 'backup_failed' => 'Backup lỗi', 'uptime_down' => 'Website không phản hồi',
        'cert_days' => 'Chứng chỉ còn (ngày)', 'http_latency_ms' => 'Thời gian phản hồi (ms)', 'http_status' => 'Mã HTTP',
    ];

    /** Server: mẫu cũ hơn ngưỡng coi như không có (mất kết nối do rule agent_offline_sec lo). */
    public const SERVER_FRESH_SEC = 180;

    /** Account: thu mỗi 5 phút. */
    public const ACCOUNT_FRESH_SEC = 900;

    /** Dịch vụ lõi: dừng mà đang enabled → tính vào service_down. */
    public const CORE_SERVICES = ['nginx', 'php8.1-fpm', 'php8.2-fpm', 'php8.3-fpm', 'php8.4-fpm', 'mariadb', 'postgresql',
        'redis-server', 'cron', 'ssh'];

    public static function supports(string $metric, string $scope): bool
    {
        return in_array($scope, self::CATALOG[$metric] ?? [], true);
    }

    public static function isPct(string $metric): bool
    {
        return str_ends_with($metric, '_pct');
    }

    /**
     * @return list<array{type: string, id: int, uuid: string, label: string, server_id: int|null, account_id: int|null,
     *     website_id: int|null, value: float|null}>
     */
    public function targets(AlertRule $rule, ?Carbon $now = null): array
    {
        $now ??= Carbon::now();

        return match ($rule->scope_type) {
            'server' => $this->servers($rule, $now),
            'hosting_account' => $this->accounts($rule, $now),
            default => $this->websites($rule, $now),
        };
    }

    /** @return list<array{type: string, id: int, uuid: string, label: string, server_id: int|null, account_id: int|null, website_id: int|null, value: float|null}> */
    private function servers(AlertRule $rule, Carbon $now): array
    {
        $q = DB::table('servers')->join('agents', 'agents.server_id', '=', 'servers.id')->whereNull('agents.revoked_at')
            ->select('servers.id', 'servers.uuid', 'servers.name', 'agents.last_seen_at', 'agents.created_at as agent_created_at');
        if ($rule->scope_id !== null) {
            $q->where('servers.id', $rule->scope_id);
        }
        $rows = $q->orderBy('servers.id')->get();
        $ids = array_values($rows->pluck('id')->map(fn ($v): int => (int) $v)->all());
        $values = match ($rule->metric) {
            'agent_offline_sec' => null,
            'service_down' => $this->servicesDown($ids),
            default => $this->latestSamples('server_id', $ids, $rule->metric, $now->copy()->subSeconds(self::SERVER_FRESH_SEC), true),
        };
        $out = [];
        foreach ($rows as $r) {
            $id = (int) $r->id;
            if ($rule->metric === 'agent_offline_sec') {
                $seen = Carbon::parse((string) ($r->last_seen_at ?? $r->agent_created_at));
                $value = (float) max(0, (int) $seen->diffInSeconds($now, true));
            } else {
                $value = $values[$id] ?? null;
            }
            $out[] = ['type' => 'server', 'id' => $id, 'uuid' => (string) $r->uuid, 'label' => (string) $r->name,
                'server_id' => $id, 'account_id' => null, 'website_id' => null, 'value' => $value];
        }

        return $out;
    }

    /** @return list<array{type: string, id: int, uuid: string, label: string, server_id: int|null, account_id: int|null, website_id: int|null, value: float|null}> */
    private function accounts(AlertRule $rule, Carbon $now): array
    {
        $q = DB::table('hosting_accounts')->whereIn('lifecycle_state', ['active', 'suspended'])->whereNull('deleted_at')
            ->select('id', 'uuid', 'username', 'server_id');
        if ($rule->scope_id !== null) {
            $q->where('id', $rule->scope_id);
        }
        $rows = $q->orderBy('id')->get();
        $ids = array_values($rows->pluck('id')->map(fn ($v): int => (int) $v)->all());
        $values = match ($rule->metric) {
            'backup_failed' => $this->backupFailed($ids),
            default => $this->latestSamples('hosting_account_id', $ids, $rule->metric === 'quota_disk_pct' ? 'disk_pct' : $rule->metric,
                $now->copy()->subSeconds(self::ACCOUNT_FRESH_SEC), false),
        };
        $out = [];
        foreach ($rows as $r) {
            $id = (int) $r->id;
            $out[] = ['type' => 'hosting_account', 'id' => $id, 'uuid' => (string) $r->uuid, 'label' => (string) $r->username,
                'server_id' => (int) $r->server_id, 'account_id' => $id, 'website_id' => null, 'value' => $values[$id] ?? null];
        }

        return $out;
    }

    /** @return list<array{type: string, id: int, uuid: string, label: string, server_id: int|null, account_id: int|null, website_id: int|null, value: float|null}> */
    private function websites(AlertRule $rule, Carbon $now): array
    {
        $q = DB::table('websites')->leftJoin('uptime_checks', 'uptime_checks.website_id', '=', 'websites.id')
            ->whereNull('websites.deleted_at')->whereNotIn('websites.status', ['deleting'])
            ->select('websites.id', 'websites.uuid', 'websites.primary_domain', 'websites.server_id', 'websites.hosting_account_id',
                'websites.ssl_mode', 'uptime_checks.enabled as up_enabled', 'uptime_checks.state as up_state',
                'uptime_checks.last_status', 'uptime_checks.last_latency_ms', 'uptime_checks.cert_expires_at');
        if ($rule->scope_id !== null) {
            $q->where('websites.id', $rule->scope_id);
        }
        $rows = $q->orderBy('websites.id')->get();
        $certs = $rule->metric === 'cert_days' ? DB::table('certificates')->whereIn('website_id', $rows->pluck('id'))
            ->whereNotNull('not_after')->whereNotIn('status', ['deleting', 'failed'])
            ->groupBy('website_id')->selectRaw('website_id, max(not_after) AS not_after')->pluck('not_after', 'website_id')->all() : [];
        $out = [];
        foreach ($rows as $r) {
            $id = (int) $r->id;
            $probing = (bool) $r->up_enabled;
            $value = match ($rule->metric) {
                'uptime_down' => $probing && in_array($r->up_state, ['up', 'down'], true) ? ($r->up_state === 'down' ? 1.0 : 0.0) : null,
                'http_latency_ms' => $probing && $r->last_latency_ms !== null ? (float) $r->last_latency_ms : null,
                'http_status' => $probing && $r->last_status !== null ? (float) $r->last_status : null,
                default => $this->certDays($r->ssl_mode === 'none' ? null : ($certs[$id] ?? $r->cert_expires_at), $now),
            };
            $out[] = ['type' => 'website', 'id' => $id, 'uuid' => (string) $r->uuid, 'label' => (string) $r->primary_domain,
                'server_id' => (int) $r->server_id, 'account_id' => (int) $r->hosting_account_id, 'website_id' => $id, 'value' => $value];
        }

        return $out;
    }

    private function certDays(mixed $notAfter, Carbon $now): ?float
    {
        if ($notAfter === null || $notAfter === '') {
            return null;
        }

        return round($now->diffInSeconds(Carbon::parse((string) $notAfter), false) / 86400, 1);
    }

    /**
     * @param  list<int>  $ids
     * @return array<int, float>
     */
    private function latestSamples(string $column, array $ids, string $metric, Carbon $since, bool $serverLevel): array
    {
        if ($ids === [] || ! in_array($metric, MetricsCollector::SAMPLE_METRICS, true)) {
            return [];
        }
        $q = DB::table('metric_samples')->selectRaw($column === 'server_id' ? 'DISTINCT ON (server_id) server_id AS k, value'
            : 'DISTINCT ON (hosting_account_id) hosting_account_id AS k, value')
            ->whereIn($column, $ids)->where('metric', $metric)->where('at', '>=', $since);
        if ($serverLevel) {
            $q->whereNull('hosting_account_id');
        }

        return $q->orderBy($column)->orderByDesc('at')->pluck('value', 'k')->map(fn ($v): float => (float) $v)->all();
    }

    /**
     * @param  list<int>  $ids
     * @return array<int, float>
     */
    private function servicesDown(array $ids): array
    {
        $out = array_fill_keys($ids, 0.0);
        $rows = DB::table('server_services')->whereIn('server_id', $ids)->whereIn('name', self::CORE_SERVICES)
            ->where('enabled', true)->where('observed_state', 'inactive')
            ->groupBy('server_id')->selectRaw('server_id, count(*) AS n')->get();
        foreach ($rows as $r) {
            $out[(int) $r->server_id] = (float) $r->n;
        }

        return $out;
    }

    /**
     * Backup gần nhất của account (job backup.run đã kết thúc) lỗi → 1, thành công → 0, chưa có → không có số liệu.
     *
     * @param  list<int>  $ids
     * @return array<int, float>
     */
    private function backupFailed(array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $rows = DB::table('jobs')->selectRaw('DISTINCT ON (resource_id) resource_id, state')
            ->where('type', 'backup.run')->where('resource_type', 'hosting_account')->whereIn('resource_id', $ids)
            ->whereIn('state', ['succeeded', 'failed', 'timed_out'])
            ->orderBy('resource_id')->orderByDesc('created_at')->get();
        $out = [];
        foreach ($rows as $r) {
            $out[(int) $r->resource_id] = $r->state === 'succeeded' ? 0.0 : 1.0;
        }

        return $out;
    }
}
