<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Gộp metric_samples (1 phút) thành metric_rollups (1 giờ: min/avg/max/samples), D-101.
 * Idempotent: upsert theo (server, account, metric, bucket) NULLS NOT DISTINCT, chạy lại cùng giờ không nhân đôi.
 * Chạy bù: từ giờ sau rollup mới nhất (tối đa lùi RETENTION_DAYS vì samples cũ hơn đã bị xóa) tới giờ đã kết thúc gần nhất;
 * luôn tính lại giờ của rollup mới nhất để nhận mẫu tới trễ. metric_samples không có FK: bỏ mẫu của server/account đã xóa.
 */
final class MetricsRollup
{
    /** @return int số giờ đã gộp */
    public function run(?Carbon $now = null): int
    {
        $now = ($now ?? Carbon::now())->copy()->utc();
        $end = $now->copy()->startOfHour(); // giờ hiện tại chưa xong: không gộp
        $floor = $end->copy()->subDays(MetricsCollector::RETENTION_DAYS);
        $last = DB::table('metric_rollups')->max('bucket');
        $start = $last !== null ? Carbon::parse((string) $last)->utc() : null;
        if ($start === null) {
            $first = DB::table('metric_samples')->min('at');
            if ($first === null) {
                return 0;
            }
            $start = Carbon::parse((string) $first)->utc()->startOfHour();
        }
        if ($start->lt($floor)) {
            $start = $floor;
        }
        $hours = 0;
        for ($h = $start->copy(); $h->lt($end); $h->addHour()) {
            $this->hour($h);
            $hours++;
        }

        return $hours;
    }

    /** Gộp đúng một giờ [h, h+1). */
    public function hour(Carbon $h): void
    {
        $from = $h->copy()->utc()->startOfHour();
        DB::statement(<<<'SQL'
            INSERT INTO metric_rollups (server_id, hosting_account_id, metric, bucket, min_value, avg_value, max_value, samples)
            SELECT server_id, hosting_account_id, metric, ?::timestamptz,
                   min(value), LEAST(GREATEST(avg(value), min(value)), max(value)), max(value), count(*)
            FROM metric_samples
            WHERE at >= ?::timestamptz AND at < ?::timestamptz
              AND server_id IN (SELECT id FROM servers)
              AND (hosting_account_id IS NULL OR hosting_account_id IN (SELECT id FROM hosting_accounts))
            GROUP BY server_id, hosting_account_id, metric
            ON CONFLICT (server_id, hosting_account_id, metric, bucket)
            DO UPDATE SET min_value = EXCLUDED.min_value, avg_value = EXCLUDED.avg_value,
                          max_value = EXCLUDED.max_value, samples = EXCLUDED.samples
            SQL, [$from->toIso8601String(), $from->toIso8601String(), $from->copy()->addHour()->toIso8601String()]);
    }
}
