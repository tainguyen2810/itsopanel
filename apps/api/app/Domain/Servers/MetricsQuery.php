<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Domain\Hosting\QuotaService;
use App\Exceptions\ApiProblem;
use App\Models\HostingAccount;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Đọc chuỗi số liệu (schema MetricSeries), D-101: khoảng ≤ 24 giờ đọc metric_samples (1 phút), dài hơn đọc
 * metric_rollups (1 giờ, trung bình có trọng số theo số mẫu). Bước chọn sao cho tối đa ~500 điểm.
 */
final class MetricsQuery
{
    /** range → [giây, bước giây, nguồn] */
    public const RANGES = [
        '1h' => [3600, 60, 'samples'],
        '24h' => [86400, 300, 'samples'],
        '7d' => [604800, 3600, 'rollup'],
        '30d' => [2592000, 10800, 'rollup'],
        '90d' => [7776000, 21600, 'rollup'],
    ];

    public const MAX_POINTS = 500;

    /** metric → đơn vị (MetricSeries.unit) */
    public const UNITS = [
        'cpu_pct' => 'pct', 'ram_pct' => 'pct', 'disk_pct' => 'pct', 'swap_pct' => 'pct', 'inode_pct' => 'pct',
        'net_in' => 'bps', 'net_out' => 'bps', 'io_read' => 'bps', 'io_write' => 'bps', 'load_1m' => 'count', 'tasks' => 'count',
    ];

    public const METRICS = ['cpu_pct', 'ram_pct', 'disk_pct', 'net_in', 'net_out', 'load_1m', 'swap_pct', 'inode_pct',
        'io_read', 'io_write', 'tasks'];

    /** Số liệu có cho account (từ cgroup + quota.report). */
    public const ACCOUNT_METRICS = ['cpu_pct', 'ram_pct', 'disk_pct', 'inode_pct', 'io_read', 'io_write', 'tasks'];

    public function __construct(private readonly QuotaService $quota) {}

    /**
     * Chuỗi số liệu account kèm đường giới hạn gói: cpu_pct theo `cpu_percent` (% một core), số liệu % khác là 100.
     *
     * @return array<string, mixed>
     */
    public function accountSeries(HostingAccount $a, string $metric, string $range): array
    {
        $limit = null;
        if ($metric === 'cpu_pct') {
            $cpu = (int) $this->quota->limits($a)['cpu_percent'];
            $limit = $cpu > 0 ? (float) $cpu : null;
        } elseif (self::UNITS[$metric] === 'pct') {
            $limit = 100.0;
        }

        return $this->series('hosting_account', $a->uuid, $a->server_id, $a->id, $metric, $range, $limit);
    }

    /**
     * @param  list<string>  $allowed
     * @return array{0: string, 1: string}
     */
    public static function validate(Request $request, array $allowed = self::METRICS): array
    {
        $metric = $request->query('metric');
        $range = $request->query('range', '24h');
        if (! is_string($metric) || ! in_array($metric, self::METRICS, true)) {
            throw ApiProblem::field('metric', 'Số liệu không hợp lệ.');
        }
        if (! in_array($metric, $allowed, true)) {
            throw ApiProblem::field('metric', 'Số liệu này không có cho loại tài nguyên này.');
        }
        if (! is_string($range) || ! isset(self::RANGES[$range])) {
            throw ApiProblem::field('range', 'Khoảng thời gian không hợp lệ.');
        }

        return [$metric, $range];
    }

    /**
     * @return array{resource: array{type: string, uuid: string}, metric: string, step_sec: int,
     *     points: list<array{0: string, 1: float}>, unit: string, source: string, limit: float|null}
     */
    public function series(string $type, string $uuid, int $serverId, ?int $accountId, string $metric, string $range,
        ?float $limit = null): array
    {
        [$span, $step, $source] = self::RANGES[$range];
        $now = Carbon::now();
        $since = $now->copy()->subSeconds($span);
        if ($source === 'samples') {
            $q = DB::table('metric_samples')->where('at', '>=', $since)
                ->selectRaw('floor(extract(epoch from at) / ?) * ? AS ts, avg(value) AS v', [$step, $step]);
        } else {
            $q = DB::table('metric_rollups')->where('bucket', '>=', $since->copy()->utc()->startOfHour())
                ->selectRaw('floor(extract(epoch from bucket) / ?) * ? AS ts, sum(avg_value * samples) / sum(samples) AS v', [$step, $step]);
        }
        $q->where('server_id', $serverId)->where('metric', $metric);
        $accountId === null ? $q->whereNull('hosting_account_id') : $q->where('hosting_account_id', $accountId);
        // Bí danh khác tên cột: GROUP BY "bucket" của PostgreSQL ưu tiên cột metric_rollups.bucket.
        $rows = $q->groupBy('ts')->orderBy('ts')->limit(self::MAX_POINTS + 2)->get();
        $points = [];
        foreach ($rows as $r) {
            $points[] = [Carbon::createFromTimestamp((int) $r->ts)->setTimezone(config('app.timezone'))->toIso8601String(),
                round((float) $r->v, 2)];
        }
        $points = array_slice($points, -self::MAX_POINTS);

        return ['resource' => ['type' => $type, 'uuid' => $uuid], 'metric' => $metric, 'step_sec' => $step, 'points' => $points,
            'unit' => self::UNITS[$metric], 'source' => $source, 'limit' => $limit];
    }
}
