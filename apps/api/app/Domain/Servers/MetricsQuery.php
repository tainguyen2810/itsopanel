<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Exceptions\ApiProblem;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/** Đọc chuỗi số liệu từ metric_samples, gộp theo bước thời gian (avg) — schema MetricSeries. */
final class MetricsQuery
{
    /** range → [giây, bước giây] */
    public const RANGES = ['1h' => [3600, 60], '24h' => [86400, 300], '7d' => [604800, 3600], '30d' => [2592000, 14400]];

    public const METRICS = ['cpu_pct', 'ram_pct', 'disk_pct', 'net_in', 'net_out', 'load_1m'];

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

    /** @return array{resource: array{type: string, uuid: string}, metric: string, step_sec: int, points: list<array{0: string, 1: float}>} */
    public function series(string $type, string $uuid, int $serverId, ?int $accountId, string $metric, string $range): array
    {
        [$span, $step] = self::RANGES[$range];
        $q = DB::table('metric_samples')->where('server_id', $serverId)->where('metric', $metric)
            ->where('at', '>=', Carbon::now()->subSeconds($span));
        $accountId === null ? $q->whereNull('hosting_account_id') : $q->where('hosting_account_id', $accountId);
        $rows = $q->selectRaw('floor(extract(epoch from at) / ?) * ? AS bucket, avg(value) AS v', [$step, $step])
            ->groupBy('bucket')->orderBy('bucket')->get();
        $points = [];
        foreach ($rows as $r) {
            $points[] = [Carbon::createFromTimestamp((int) $r->bucket)->setTimezone(config('app.timezone'))->toIso8601String(),
                round((float) $r->v, 2)];
        }

        return ['resource' => ['type' => $type, 'uuid' => $uuid], 'metric' => $metric, 'step_sec' => $step, 'points' => $points];
    }
}
