<?php

declare(strict_types=1);

namespace App\Domain\Monitoring;

use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\UptimeCheck;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Uptime check (D-105): agent của server chứa website gọi HTTP(S) tới domain chính của website qua op uptime.probe
 * (lô ≤ 50, timeout 10 giây/URL). 3 lần lỗi liên tiếp → down; 1 lần thành công → up. Kết quả vào uptime_results
 * (partition ngày, 7 ngày) và uptime_rollups (giờ, 90 ngày) cho % 24 giờ / 7 ngày / 30 ngày.
 */
final class UptimeService
{
    public const DOWN_AFTER = 3;

    public const BATCH = 50;

    public const TIMEOUT_SEC = 10;

    public const RESULT_RETENTION_DAYS = 7;

    public const ROLLUP_RETENTION_DAYS = 90;

    public function __construct(private readonly AgentClient $agent) {}

    /** URL hiển thị (không do người dùng nhập): scheme theo SSL của website + domain chính + path. */
    public static function url(Website $w, string $path): string
    {
        return self::scheme($w).'://'.$w->primary_domain.$path;
    }

    public static function scheme(Website $w): string
    {
        return ($w->ssl_mode ?? 'none') === 'none' ? 'http' : 'https';
    }

    /** Mặc định bật uptime khi website có SSL (gọi từ sự kiện lưu Website); đã có check thì giữ nguyên. */
    public static function ensureDefault(Website $w): void
    {
        if (($w->ssl_mode ?? 'none') !== 'none' && ! UptimeCheck::query()->where('website_id', $w->id)->exists()) {
            UptimeCheck::query()->create(['website_id' => $w->id, 'path' => '/', 'interval_sec' => 60, 'enabled' => true]);
        }
    }

    /**
     * Gọi các check đến hạn, gom theo server. Server không trả lời: bỏ qua lượt này (rule mất kết nối báo riêng).
     *
     * @return array{checked: int, failed_servers: int}
     */
    public function probeDue(?Carbon $now = null): array
    {
        $now ??= Carbon::now();
        $checks = UptimeCheck::query()->with('website')->where('enabled', true)
            ->whereHas('website', fn ($w) => $w->whereNotIn('status', ['deleting', 'pending']))
            ->where(fn ($q) => $q->whereNull('last_checked_at')
                ->orWhereRaw('last_checked_at <= ?::timestamptz - make_interval(secs => interval_sec - 5)', [$now->toIso8601String()]))
            ->orderBy('id')->get();
        $out = ['checked' => 0, 'failed_servers' => 0];
        foreach ($checks->groupBy(fn (UptimeCheck $c): int => $c->website->server_id) as $serverId => $group) {
            foreach ($group->chunk(self::BATCH) as $chunk) {
                $byUuid = $chunk->keyBy('uuid');
                try {
                    $res = $this->agent->forServer((int) $serverId)->call('uptime.probe', [
                        'targets' => $chunk->map(fn (UptimeCheck $c): array => ['check_uuid' => $c->uuid,
                            'host' => $c->website->primary_domain, 'path' => $c->path, 'scheme' => self::scheme($c->website),
                            'keyword' => $c->keyword])->values()->all(),
                        'timeout_sec' => self::TIMEOUT_SEC,
                    ], timeout: self::TIMEOUT_SEC * 2 + 10);
                } catch (AgentUnavailable) {
                    $out['failed_servers']++;

                    continue 2;
                }
                if (! $res->ok) {
                    $out['failed_servers']++;

                    continue 2;
                }
                foreach ((array) ($res->data['results'] ?? []) as $r) {
                    $c = is_array($r) ? $byUuid->get((string) ($r['check_uuid'] ?? '')) : null;
                    if ($c instanceof UptimeCheck) {
                        $this->record($c, $r, $now);
                        $out['checked']++;
                    }
                }
            }
        }

        return $out;
    }

    /** @param  array<string, mixed>  $r  một phần tử results của uptime.probe */
    public function record(UptimeCheck $c, array $r, Carbon $now): void
    {
        $ok = ($r['ok'] ?? false) === true;
        $status = is_int($r['status'] ?? null) ? $r['status'] : null;
        $latency = is_int($r['duration_ms'] ?? null) ? $r['duration_ms'] : null;
        $error = is_string($r['error'] ?? null) ? mb_substr($r['error'], 0, 300) : null;
        DB::select('SELECT itso_ensure_uptime_partition(?::date)', [$now->copy()->utc()->toDateString()]);
        DB::table('uptime_results')->insert(['check_id' => $c->id, 'ok' => $ok, 'status' => $status, 'latency_ms' => $latency,
            'error' => $ok ? null : $error, 'at' => $now]);
        $c->last_status = $status;
        $c->last_latency_ms = $latency;
        $c->last_error = $ok ? null : $error;
        $c->last_checked_at = $now;
        if (is_string($r['cert_expires_at'] ?? null)) {
            $c->cert_expires_at = Carbon::parse($r['cert_expires_at']);
        }
        if ($ok) {
            $c->consecutive_failures = 0;
            $c->state = 'up';
            $c->down_since = null;
        } else {
            $c->consecutive_failures++;
            if ($c->consecutive_failures >= self::DOWN_AFTER && $c->state !== 'down') {
                $c->state = 'down';
                $c->down_since = $now;
            }
        }
        $c->save();
    }

    /**
     * % uptime: 24 giờ và 7 ngày từ uptime_results (mẫu chi tiết), 30 ngày từ uptime_rollups + giờ chưa gộp.
     * Chưa có mẫu → 100 (chưa biết là chưa có sự cố).
     *
     * @return array{uptime_24h: float, uptime_7d: float, uptime_30d: float}
     */
    public function percentages(UptimeCheck $c, ?Carbon $now = null): array
    {
        $now ??= Carbon::now();
        $pct = function (?\stdClass $r): float {
            $total = (int) ($r->total ?? 0);

            return $total > 0 ? round((int) ($r->ok ?? 0) * 100 / $total, 2) : 100.0;
        };
        $res = fn (Carbon $since) => DB::table('uptime_results')->where('check_id', $c->id)->where('at', '>=', $since)
            ->selectRaw('count(*) FILTER (WHERE ok) AS ok, count(*) AS total')->first();
        $hour = $now->copy()->utc()->startOfHour();
        $rolled = DB::table('uptime_rollups')->where('check_id', $c->id)->where('bucket', '>=', $now->copy()->subDays(30))
            ->where('bucket', '<', $hour)->selectRaw('coalesce(sum(ok_count), 0) AS ok, coalesce(sum(total), 0) AS total')->first();
        $recent = DB::table('uptime_results')->where('check_id', $c->id)->where('at', '>=', $hour)
            ->selectRaw('count(*) FILTER (WHERE ok) AS ok, count(*) AS total')->first();
        $month = (object) ['ok' => (int) ($rolled->ok ?? 0) + (int) ($recent->ok ?? 0),
            'total' => (int) ($rolled->total ?? 0) + (int) ($recent->total ?? 0)];

        return ['uptime_24h' => $pct($res($now->copy()->subDay())), 'uptime_7d' => $pct($res($now->copy()->subDays(7))),
            'uptime_30d' => $pct($month)];
    }

    /** Gộp uptime_results theo giờ (idempotent, chạy bù như MetricsRollup). Trả số giờ đã gộp. */
    public function rollup(?Carbon $now = null): int
    {
        $end = ($now ?? Carbon::now())->copy()->utc()->startOfHour();
        $floor = $end->copy()->subDays(self::RESULT_RETENTION_DAYS);
        $last = DB::table('uptime_rollups')->max('bucket');
        $start = $last !== null ? Carbon::parse((string) $last)->utc() : null;
        if ($start === null) {
            $first = DB::table('uptime_results')->min('at');
            if ($first === null) {
                return 0;
            }
            $start = Carbon::parse((string) $first)->utc()->startOfHour();
        }
        $start = $start->lt($floor) ? $floor : $start;
        $n = 0;
        for ($h = $start->copy(); $h->lt($end); $h->addHour()) {
            DB::statement(<<<'SQL'
                INSERT INTO uptime_rollups (check_id, bucket, ok_count, total, avg_latency_ms)
                SELECT check_id, ?::timestamptz, count(*) FILTER (WHERE ok), count(*), round(avg(latency_ms))::int
                FROM uptime_results
                WHERE at >= ?::timestamptz AND at < ?::timestamptz AND check_id IN (SELECT id FROM uptime_checks)
                GROUP BY check_id
                ON CONFLICT (check_id, bucket) DO UPDATE SET ok_count = EXCLUDED.ok_count, total = EXCLUDED.total,
                    avg_latency_ms = EXCLUDED.avg_latency_ms
                SQL, [$h->toIso8601String(), $h->toIso8601String(), $h->copy()->addHour()->toIso8601String()]);
            $n++;
        }

        return $n;
    }

    /** Tạo trước partition 2 ngày, drop partition uptime_results quá 7 ngày, xóa rollup quá 90 ngày. */
    public function prune(?Carbon $now = null): int
    {
        $now = ($now ?? Carbon::now())->copy()->utc();
        for ($i = 0; $i <= 2; $i++) {
            DB::select('SELECT itso_ensure_uptime_partition(?::date)', [$now->copy()->addDays($i)->toDateString()]);
        }
        $cut = $now->copy()->subDays(self::RESULT_RETENTION_DAYS)->format('Ymd');
        $dropped = 0;
        foreach (DB::select("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
            JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'uptime_results'") as $r) {
            if (preg_match('/^uptime_results_(\d{8})$/', (string) $r->relname, $m) === 1 && $m[1] < $cut) {
                DB::statement('DROP TABLE IF EXISTS "'.$r->relname.'"'); // tên đã khớp regex chặt
                $dropped++;
            }
        }
        DB::table('uptime_results_default')->where('at', '<', $now->copy()->subDays(self::RESULT_RETENTION_DAYS)->startOfDay())->delete();
        DB::table('uptime_rollups')->where('bucket', '<', $now->copy()->subDays(self::ROLLUP_RETENTION_DAYS))->delete();

        return $dropped;
    }
}
