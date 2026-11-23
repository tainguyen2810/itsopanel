<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Domain\Monitoring\DefaultAlertRules;
use App\Models\Agent;
use App\Models\Database;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use App\Models\WebsiteDomain;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;
use RuntimeException;

/**
 * Dữ liệu tổng hợp đo hiệu năng (Prompt 12.5, D-112, ADR 0057). CHỈ chạy ở local/testing: 1 server, 200 account × 3 website
 * × 2 DB, 7 ngày metrics (server mỗi phút, account mỗi 5 phút), 10 000 job, 100 000 audit. Bảng lớn chèn bằng
 * `generate_series` (một câu SQL) để seed chạy trong vài chục giây.
 *
 *   php artisan db:seed --class=PerfSeeder      (rồi) php artisan itso:bench
 */
final class PerfSeeder extends Seeder
{
    public const ACCOUNTS = 200;

    public const SITES_PER_ACCOUNT = 3;

    public const DBS_PER_ACCOUNT = 2;

    public const DAYS = 7;

    public const JOBS = 10000;

    public const AUDITS = 100000;

    /** Metric server mỗi phút, metric account mỗi 5 phút (MetricsCollector::SAMPLE_METRICS). */
    public const SERVER_METRICS = ['cpu_pct', 'ram_pct', 'disk_pct', 'load_1m', 'net_in', 'net_out'];

    public const ACCOUNT_METRICS = ['cpu_pct', 'ram_mb', 'io_read', 'io_write', 'tasks', 'disk_mb'];

    public function run(): void
    {
        if (! app()->environment(['local', 'testing'])) {
            throw new RuntimeException('PerfSeeder chỉ chạy ở môi trường local/testing.');
        }
        $this->call([RoleSeeder::class, PermissionSeeder::class]);
        $server = Server::factory()->create(['name' => 'perf-01', 'ip_addresses' => ['203.0.113.200'],
            'observed_facts' => ['ram_mb' => 32768, 'disk_mb' => 1024000, 'cpu_cores' => 16]]);
        Agent::query()->create(['server_id' => $server->id, 'transport' => 'local', 'last_seen_at' => now()]);
        $pkg = HostingPackage::factory()->create(['code' => 'perf', 'name' => 'Perf']);
        $ver = $pkg->versions()->firstOrFail();
        $owners = User::factory()->portalUser()->count(50)->create();
        $sa = User::query()->where('email', 'perf-sa@itso.local')->first()
            ?? User::factory()->superAdmin()->create(['email' => 'perf-sa@itso.local', 'name' => 'Perf SA']);

        for ($i = 1; $i <= self::ACCOUNTS; $i++) {
            $u = sprintf('perf%03d', $i);
            $a = HostingAccount::factory()->create(['server_id' => $server->id, 'package_version_id' => $ver->id,
                'owner_user_id' => $owners[$i % 50]->id, 'username' => $u, 'uid' => 30000 + $i, 'home_path' => "/home/$u"]);
            for ($s = 1; $s <= self::SITES_PER_ACCOUNT; $s++) {
                $w = Website::query()->create(['hosting_account_id' => $a->id, 'server_id' => $server->id,
                    'primary_domain' => "s$s-$u.perf.vn", 'type' => 'php', 'php_version' => '8.3', 'status' => 'ready']);
                WebsiteDomain::query()->create(['website_id' => $w->id, 'name' => "s$s-$u.perf.vn", 'type' => 'primary']);
            }
            for ($d = 1; $d <= self::DBS_PER_ACCOUNT; $d++) {
                Database::query()->create(['hosting_account_id' => $a->id, 'server_id' => $server->id, 'engine' => 'mariadb',
                    'name' => "{$u}_db$d", 'charset' => 'utf8mb4', 'status' => 'ready', 'size_mb' => 50 * $d]);
            }
        }
        app(DefaultAlertRules::class)->ensure();

        $sid = $server->id;
        $days = self::DAYS;
        for ($d = 0; $d <= $days + 1; $d++) {
            DB::select('SELECT itso_ensure_metric_partition((current_date - ?::int)::date)', [$d]);
            DB::select('SELECT itso_ensure_metric_partition((current_date + ?::int)::date)', [$d]);
        }
        $serverMetrics = "ARRAY['".implode("','", self::SERVER_METRICS)."']";
        $accountMetrics = "ARRAY['".implode("','", self::ACCOUNT_METRICS)."']";
        DB::statement(<<<SQL
            INSERT INTO metric_samples (server_id, hosting_account_id, metric, value, at)
            SELECT $sid, NULL, m, round((random() * 80)::numeric, 2), t
            FROM generate_series(date_trunc('minute', now()) - interval '$days days', date_trunc('minute', now()), interval '1 minute') t,
                 unnest($serverMetrics) m
            SQL);
        DB::statement(<<<SQL
            INSERT INTO metric_samples (server_id, hosting_account_id, metric, value, at)
            SELECT $sid, a.id, m, round((random() * 50)::numeric, 2), t
            FROM generate_series(date_trunc('minute', now()) - interval '$days days', date_trunc('minute', now()), interval '5 minutes') t,
                 (SELECT id FROM hosting_accounts WHERE server_id = $sid) a,
                 unnest($accountMetrics) m
            SQL);
        DB::statement(<<<SQL
            INSERT INTO metric_rollups (server_id, hosting_account_id, metric, bucket, min_value, avg_value, max_value, samples)
            SELECT server_id, hosting_account_id, metric, date_trunc('hour', at), min(value), avg(value), max(value), count(*)
            FROM metric_samples WHERE server_id = $sid GROUP BY 1, 2, 3, 4
            SQL);

        $jobs = self::JOBS;
        DB::statement(<<<SQL
            INSERT INTO jobs (type, server_id, resource_type, resource_id, requested_by_user_id, state, progress, attempts, max_attempts,
                timeout_sec, started_at, finished_at, created_at, updated_at)
            SELECT (ARRAY['website.update','backup.run','hosting_account.update','certificate.renew'])[1 + g % 4], $sid, 'hosting_account',
                a.ids[1 + g % array_length(a.ids, 1)], {$sa->id},
                (ARRAY['succeeded','succeeded','succeeded','failed'])[1 + g % 4], 100, 1, 3, 600,
                now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval + interval '20 seconds',
                now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval
            FROM generate_series(1, $jobs) g, (SELECT array_agg(id ORDER BY id) ids FROM hosting_accounts WHERE server_id = $sid) a
            SQL);
        $audits = self::AUDITS;
        DB::statement(<<<SQL
            INSERT INTO audit_logs (at, actor_user_id, actor_ip, action, resource_type, resource_id, server_id, changes, result)
            SELECT now() - (($audits - g) * 6 || ' seconds')::interval, {$sa->id}, '203.0.113.9',
                (ARRAY['website.update','database.create','user.login','backup.run','hosting_account.update'])[1 + g % 5],
                'hosting_account', a.ids[1 + g % array_length(a.ids, 1)],
                $sid, jsonb_build_object('n', g), 'success'
            FROM generate_series(1, $audits) g, (SELECT array_agg(id ORDER BY id) ids FROM hosting_accounts WHERE server_id = $sid) a
            SQL);
        DB::statement('ANALYZE');
    }
}
