<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Auth\ApiTokenAuth;
use App\Auth\Permissions;
use App\Domain\Monitoring\AlertEngine;
use App\Domain\Servers\MetricsCollector;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use Illuminate\Console\Command;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Đo hiệu năng (Prompt 12.5, D-112, ADR 0057) trên dữ liệu PerfSeeder: API qua HTTP kernel nội bộ (không mạng, token
 * Bearer của SUPER_ADMIN tạm), lệnh đánh giá cảnh báo, chèn metrics của mọi account. In p50/p95/max + số truy vấn SQL.
 * Chỉ chạy ở local/testing (tạo token tạm rồi xóa).
 */
final class BenchCommand extends Command
{
    protected $signature = 'itso:bench {--n=30 : số lượt mỗi endpoint} {--json : in JSON thay cho bảng Markdown}';

    protected $description = 'Đo p50/p95/max API danh sách/chi tiết, itso:alerts-evaluate, insert metrics (dữ liệu PerfSeeder)';

    /** Mục tiêu D-112 (ms). */
    private const TARGET = ['list' => 300, 'detail' => 200, 'alerts' => 10000, 'metrics_insert' => 5000];

    public function handle(Kernel $kernel, AlertEngine $alerts, MetricsCollector $metrics): int
    {
        if (! app()->environment(['local', 'testing'])) {
            throw new RuntimeException('itso:bench chỉ chạy ở môi trường local/testing.');
        }
        $server = Server::query()->where('name', 'perf-01')->first();
        $sa = User::query()->where('email', 'perf-sa@itso.local')->first();
        if (! $server instanceof Server || ! $sa instanceof User) {
            $this->error('Chưa có dữ liệu: php artisan db:seed --class=PerfSeeder');

            return self::FAILURE;
        }
        $n = max(3, (int) $this->option('n'));
        $tok = ApiTokenAuth::newToken();
        $scopes = [];
        foreach (Permissions::CATALOG as $group => $perms) {
            foreach (array_keys($perms) as $perm) {
                if (! str_contains($perm, '*')) {
                    $scopes[] = explode(':', Permissions::tokenScope($perm))[0].':write';
                }
            }
        }
        $tokenId = DB::table('api_tokens')->insertGetId(['user_id' => $sa->id, 'name' => 'itso:bench', 'token_hash' => $tok['hash'],
            'scopes' => json_encode(array_values(array_unique($scopes))), 'expires_at' => Carbon::now()->addHour()]);
        $acc = HostingAccount::query()->where('server_id', $server->id)->orderBy('id')->skip(100)->firstOrFail();
        $site = Website::query()->where('hosting_account_id', $acc->id)->firstOrFail();
        $job = Job::query()->where('server_id', $server->id)->orderByDesc('id')->skip(500)->firstOrFail();
        $endpoints = [
            ['list', '/api/v1/admin/hosting-accounts?limit=50'],
            ['list', '/api/v1/admin/hosting-accounts?limit=50&q=perf1'],
            ['list', '/api/v1/admin/websites?limit=50'],
            ['list', '/api/v1/admin/databases?limit=50'],
            ['list', '/api/v1/admin/jobs?limit=50'],
            ['list', '/api/v1/admin/audit-logs?limit=50'],
            ['list', '/api/v1/admin/users?limit=50'],
            ['list', '/api/v1/admin/servers'],
            ['list', "/api/v1/admin/metrics/servers/{$server->uuid}/accounts"],
            ['detail', '/api/v1/admin/dashboard/summary'],
            ['detail', "/api/v1/admin/hosting-accounts/{$acc->uuid}"],
            ['detail', "/api/v1/admin/websites/{$site->uuid}"],
            ['detail', "/api/v1/admin/jobs/{$job->uuid}"],
            ['detail', "/api/v1/admin/servers/{$server->uuid}"],
            ['detail', "/api/v1/admin/metrics/servers/{$server->uuid}?range=24h&metric=cpu_pct"],
            ['detail', "/api/v1/admin/metrics/servers/{$server->uuid}?range=7d&metric=cpu_pct"],
            ['detail', "/api/v1/admin/metrics/hosting-accounts/{$acc->uuid}?range=24h&metric=cpu_pct"],
        ];
        $rows = [];
        try {
            foreach ($endpoints as [$kind, $uri]) {
                $times = [];
                $queries = 0;
                $status = 0;
                for ($i = 0; $i < $n + 1; $i++) {
                    $q = 0;
                    DB::flushQueryLog();
                    DB::enableQueryLog();
                    $t = hrtime(true);
                    $res = $kernel->handle(Request::create($uri, 'GET', [], [], [], ['HTTP_AUTHORIZATION' => 'Bearer '.$tok['plain'],
                        'HTTP_ACCEPT' => 'application/json', 'REMOTE_ADDR' => '127.0.0.1']));
                    $ms = (hrtime(true) - $t) / 1e6;
                    $q = count(DB::getQueryLog());
                    DB::disableQueryLog();
                    $status = $res->getStatusCode();
                    app('auth')->forgetGuards();
                    if ($i === 0) {
                        continue; // lượt làm nóng (opcache, kết nối)
                    }
                    $times[] = $ms;
                    $queries = $q;
                }
                $rows[] = ['kind' => $kind, 'name' => 'GET '.preg_replace('/[0-9a-f-]{36}/', '{id}', $uri), 'status' => $status,
                    'queries' => $queries] + self::stats($times) + ['target' => self::TARGET[$kind]];
            }
        } finally {
            DB::table('api_tokens')->where('id', $tokenId)->delete();
        }

        $times = [];
        for ($i = 0; $i < 5; $i++) {
            $t = hrtime(true);
            $alerts->evaluate();
            $times[] = (hrtime(true) - $t) / 1e6;
        }
        $rows[] = ['kind' => 'alerts', 'name' => 'itso:alerts-evaluate (1 lượt)', 'status' => 0, 'queries' => 0] + self::stats($times)
            + ['target' => self::TARGET['alerts']];

        $accounts = HostingAccount::query()->where('server_id', $server->id)->pluck('id');
        $times = [];
        for ($i = 0; $i < 5; $i++) {
            $at = Carbon::now()->addMinutes($i + 1);
            $t = hrtime(true);
            DB::transaction(function () use ($accounts, $metrics, $server, $at): void {
                foreach ($accounts as $id) {
                    $metrics->insertSamples($server->id, (int) $id, ['cpu_pct' => 12.5, 'ram_mb' => 300, 'io_read' => 1000,
                        'io_write' => 2000, 'tasks' => 12, 'disk_mb' => 800, 'inode_pct' => 3.2], $at);
                }
            });
            $times[] = (hrtime(true) - $t) / 1e6;
        }
        $rows[] = ['kind' => 'metrics_insert', 'name' => 'insert metric_samples '.count($accounts).' account × 7 metric', 'status' => 0,
            'queries' => count($accounts)] + self::stats($times) + ['target' => self::TARGET['metrics_insert']];

        if ($this->option('json')) {
            $this->line((string) json_encode($rows, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        } else {
            $this->line('| Phép đo | HTTP | SQL/lượt | p50 ms | p95 ms | max ms | Mục tiêu p95 | Đạt |');
            $this->line('|---|---|---|---|---|---|---|---|');
            foreach ($rows as $r) {
                $this->line(sprintf('| %s | %s | %d | %.1f | %.1f | %.1f | ≤ %d | %s |', $r['name'], $r['status'] ?: '-', $r['queries'],
                    $r['p50'], $r['p95'], $r['max'], $r['target'], $r['p95'] <= $r['target'] ? '✓' : '✗'));
            }
        }
        $bad = array_filter($rows, fn (array $r): bool => $r['p95'] > $r['target'] || ($r['status'] !== 0 && $r['status'] !== 200));

        return $bad === [] ? self::SUCCESS : self::FAILURE;
    }

    /**
     * @param  list<float>  $t
     * @return array{p50: float, p95: float, max: float}
     */
    private static function stats(array $t): array
    {
        sort($t);
        $pick = fn (float $p): float => $t[(int) min(count($t) - 1, max(0, (int) ceil($p * count($t)) - 1))];

        return ['p50' => round($pick(0.5), 1), 'p95' => round($pick(0.95), 1), 'max' => round((float) end($t), 1)];
    }
}
