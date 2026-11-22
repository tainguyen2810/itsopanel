<?php

use App\Domain\Hosting\QuotaService;
use App\Domain\Servers\MetricsCollector;
use App\Domain\Servers\MetricsQuery;
use App\Domain\Servers\MetricsRollup;
use App\Models\Agent;
use App\Models\HostingAccount;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 11.3 (D-101): metrics mở rộng, thu account theo lô, rollup giờ, prune partition, API theo khoảng, usage account.

const P11A = 'itso-admin-v1.yaml';
const P11P = 'itso-portal-v1.yaml';

function p11agent(Actors $a, array $over = []): FakeAgent
{
    Agent::query()->firstOrCreate(['server_id' => $a->server->id], ['transport' => 'local']);

    return new FakeAgent($over + [
        'system.ping' => fn () => ['pong' => true, 'agent_version' => '0.5.0', 'mode' => 'sandbox'],
        'system.info' => fn () => ['os' => 'Ubuntu 24.04.1 LTS', 'kernel' => '6.8.0-48-generic', 'hostname' => 'srv-test',
            'uptime_sec' => 3600, 'cpu_cores' => 4, 'ram_mb' => 8192, 'disk_total_mb' => 100000, 'disk_free_mb' => 60000,
            'cgroup_v2' => true, 'systemd' => true, 'quota_mode' => 'soft', 'arch' => 'amd64'],
        'metrics.snapshot' => fn () => ['cpu_pct' => 12.5, 'ram_used_mb' => 2048, 'ram_total_mb' => 8192, 'swap_used_mb' => 512,
            'swap_total_mb' => 2048, 'disk_used_mb' => 40000, 'disk_total_mb' => 100000, 'inode_used' => 250, 'inode_total' => 1000,
            'load_1m' => 0.7, 'load_5m' => 0.5, 'load_15m' => 0.4, 'tasks' => 321, 'io_read_bps' => 1500.5, 'io_write_bps' => 800.0,
            'net' => [['iface' => 'eth0', 'rx_bps' => 1000.0, 'tx_bps' => 300.0], ['iface' => 'eth1', 'rx_bps' => 24.0, 'tx_bps' => 2.0]],
            'mounts' => []],
        'service.status' => fn () => ['services' => []],
        'quota.report' => fn (array $env) => ['usage' => array_map(fn (array $acc) => ['username' => $acc['username'],
            'disk_mb' => 512, 'inodes' => 1000, 'cpu_pct' => 1.0, 'ram_mb' => 64], $env['params']['accounts'])],
        'metrics.cgroup' => fn (array $env) => ['sampled_at' => now()->toIso8601String(), 'accounts' => [
            ['username' => $a->account->username, 'cpu_usage_usec' => 1, 'cpu_throttled_usec' => 0, 'memory_current_mb' => 300,
                'memory_max_mb' => 1024, 'pids_current' => 17, 'oom_kills' => 0, 'cpu_pct' => 42.5, 'io_read_bytes' => 1,
                'io_write_bytes' => 1, 'io_read_bps' => 2000.0, 'io_write_bps' => 900.0],
            // Slice của account không thuộc panel/server này: bỏ qua.
            ['username' => 'lala', 'cpu_usage_usec' => 1, 'cpu_throttled_usec' => 0, 'memory_current_mb' => 1, 'memory_max_mb' => null,
                'pids_current' => 1, 'oom_kills' => 0, 'cpu_pct' => 99.0, 'io_read_bytes' => 1, 'io_write_bytes' => 1, 'io_read_bps' => 1.0,
                'io_write_bps' => 1.0],
        ]],
        '*' => fn () => ['ok' => true],
    ]);
}

function p11sample(int $server, ?int $account, string $metric, float $v, Carbon $at): void
{
    app(MetricsCollector::class)->insertSamples($server, $account, [$metric => $v], $at);
}

it('metrics-collect ghi số liệu mở rộng (swap, inode, net, IO, tasks); API server đủ metric, đơn vị, nguồn samples', function () {
    $a = new Actors($this);
    p11agent($a);
    $this->artisan('itso:metrics-collect')->assertSuccessful();
    $vals = DB::table('metric_samples')->whereNull('hosting_account_id')->pluck('value', 'metric')->map(fn ($v) => (float) $v)->all();
    expect($vals)->toMatchArray(['swap_pct' => 25.0, 'inode_pct' => 25.0, 'net_in' => 1024.0, 'net_out' => 302.0,
        'io_read' => 1500.5, 'io_write' => 800.0, 'tasks' => 321.0, 'cpu_pct' => 12.5]);
    $sa = $a->spa('SA');
    foreach (['swap_pct' => 'pct', 'net_in' => 'bps', 'tasks' => 'count'] as $metric => $unit) {
        $r = $sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}?metric=$metric&range=1h");
        assertMatchesContract(P11A, 'get', '/api/v1/admin/metrics/servers/{id}', 200, $r);
        expect($r->json('data'))->toMatchArray(['unit' => $unit, 'source' => 'samples', 'limit' => null, 'step_sec' => 60])
            ->and($r->json('data.points'))->toHaveCount(1);
    }
    expect($sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}?metric=cpu_pct&range=90d")->json('data.source'))->toBe('rollup');
});

it('usage-refresh: một metrics.cgroup lô mỗi server; top account đúng từng account; phạm vi ADMIN', function () {
    $a = new Actors($this);
    $other = HostingAccount::factory()->create(['server_id' => $a->server->id, 'username' => 'zz'.substr($a->account->username, 0, 6)]);
    $agent = p11agent($a);
    $this->artisan('itso:usage-refresh')->assertSuccessful();
    $cg = collect($agent->calls)->where('op', 'metrics.cgroup')->values();
    expect($cg)->toHaveCount(2) // 2 server (Actors tạo account trên server khác) → mỗi server một lần
        ->and($cg->every(fn (array $c) => $c['params'] === []))->toBeTrue();

    $sa = $a->spa('SA');
    $r = $sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}/accounts");
    assertMatchesContract(P11A, 'get', '/api/v1/admin/metrics/servers/{id}/accounts', 200, $r);
    expect($r->json('data'))->toHaveCount(2);
    $top = $r->json('data.0');
    expect($top['hosting_account']['uuid'])->toBe($a->account->uuid)
        ->and($top)->toMatchArray(['cpu_pct' => 42.5, 'ram_mb' => 300, 'io_read_bps' => 2000, 'io_write_bps' => 900, 'tasks' => 17,
            'disk_mb' => 512])
        ->and($top['sampled_at'])->not->toBeNull();
    // Account không có slice (chưa chạy tiến trình): số liệu quota.report, IO/tasks = 0.
    expect($r->json('data.1'))->toMatchArray(['cpu_pct' => 1, 'ram_mb' => 64, 'tasks' => 0]);
    expect($r->json('data.1.hosting_account.uuid'))->toBe($other->uuid);
    // Sắp xếp + tìm + phân trang (cursor).
    $p1 = $sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}/accounts?sort=-ram_mb&limit=1");
    expect($p1->json('data.0.ram_mb'))->toEqual(300)->and($p1->json('meta.next_cursor'))->toBeString();
    $p2 = $sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}/accounts?sort=-ram_mb&limit=1&cursor=".urlencode($p1->json('meta.next_cursor')));
    expect($p2->json('data.0.hosting_account.uuid'))->toBe($other->uuid)->and($p2->json('meta.next_cursor'))->toBeNull();
    expect($sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}/accounts?q=zz")->json('data'))->toHaveCount(1);
    expect($sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}/accounts?sort=-evil")->status())->toBe(422)
        ->and($sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}/accounts?cursor=xyz")->status())->toBe(422);

    // Usage hiện tại của account (Portal + dashboard) dùng số cgroup.
    $u = $a->spa('US_OWNER')->get("/api/v1/portal/hosting-accounts/{$a->account->uuid}/usage");
    expect($u->json('data.cpu_percent.used'))->toEqual(42.5)->and($u->json('data.ram_mb.used'))->toBe(300);

    expect($a->spa('AD_IN')->get("/api/v1/admin/metrics/servers/{$a->server->uuid}/accounts")->json('data'))->toHaveCount(2);
    expect($a->spa('AD_OUT')->get("/api/v1/admin/metrics/servers/{$a->server->uuid}/accounts")->status())->toBe(404);
});

it('chuỗi số liệu account: giới hạn gói, USER chỉ xem account của mình (404 ngoài phạm vi), ADMIN theo server', function () {
    $a = new Actors($this);
    p11agent($a);
    $this->artisan('itso:usage-refresh')->assertSuccessful();
    $id = $a->account->uuid;

    $p = $a->spa('US_OWNER')->get("/api/v1/portal/hosting-accounts/$id/usage-history?metric=ram_pct&range=24h");
    assertMatchesContract(P11P, 'get', '/api/v1/portal/hosting-accounts/{id}/usage-history', 200, $p);
    expect($p->json('data'))->toMatchArray(['unit' => 'pct', 'limit' => 100, 'source' => 'samples'])
        ->and($p->json('data.points'))->toHaveCount(1);
    $cpu = $a->spa('US_OWNER')->get("/api/v1/portal/hosting-accounts/$id/usage-history?metric=cpu_pct");
    expect($cpu->json('data.limit'))->toEqual((float) app(QuotaService::class)->limits($a->account->refresh())['cpu_percent'])
        ->and($cpu->json('data.points.0.1'))->toEqual(42.5);
    expect($a->spa('US_OWNER')->get("/api/v1/portal/hosting-accounts/$id/usage-history?metric=net_in")->status())->toBe(422);
    expect($a->spa('US_OTHER')->get("/api/v1/portal/hosting-accounts/$id/usage-history?metric=cpu_pct")->status())->toBe(404);

    $io = $a->spa('AD_IN')->get("/api/v1/admin/metrics/hosting-accounts/$id?metric=io_read&range=1h");
    assertMatchesContract(P11A, 'get', '/api/v1/admin/metrics/hosting-accounts/{id}', 200, $io);
    expect($io->json('data'))->toMatchArray(['unit' => 'bps', 'limit' => null])->and($io->json('data.points.0.1'))->toEqual(2000);
    expect($a->spa('AD_OUT')->get("/api/v1/admin/metrics/hosting-accounts/$id?metric=io_read")->status())->toBe(404);
});

it('rollup giờ: min/avg/max đúng, chạy lại không nhân đôi, mẫu tới trễ được cập nhật, chạy bù nhiều giờ', function () {
    $a = new Actors($this);
    $this->travelTo(Carbon::parse('2026-11-22 10:30:00', 'UTC'));
    $h8 = Carbon::parse('2026-11-22 08:00:00', 'UTC');
    foreach ([[1.0, 5], [2.0, 20], [6.0, 40]] as [$v, $min]) {
        p11sample($a->server->id, null, 'cpu_pct', $v, $h8->copy()->addMinutes($min));
    }
    p11sample($a->server->id, null, 'cpu_pct', 10.0, $h8->copy()->addHour()->addMinutes(5)); // 09:05
    p11sample($a->server->id, $a->account->id, 'cpu_pct', 7.0, $h8->copy()->addMinutes(1));
    p11sample($a->server->id, null, 'cpu_pct', 99.0, Carbon::parse('2026-11-22 10:10:00', 'UTC')); // giờ đang chạy: chưa gộp

    expect(app(MetricsRollup::class)->run())->toBe(2);
    $r = DB::table('metric_rollups')->whereNull('hosting_account_id')->where('bucket', $h8)->first();
    expect((float) $r->min_value)->toBe(1.0)->and((float) $r->avg_value)->toBe(3.0)->and((float) $r->max_value)->toBe(6.0)
        ->and($r->samples)->toBe(3);
    expect(DB::table('metric_rollups')->count())->toBe(3); // 08 server, 08 account, 09 server

    $this->artisan('itso:metrics-rollup')->assertSuccessful();
    expect(DB::table('metric_rollups')->count())->toBe(3);

    // Mẫu tới trễ vào giờ 09 → lần sau tính lại 09.
    p11sample($a->server->id, null, 'cpu_pct', 20.0, $h8->copy()->addHour()->addMinutes(50));
    app(MetricsRollup::class)->run();
    $r9 = DB::table('metric_rollups')->whereNull('hosting_account_id')->where('bucket', $h8->copy()->addHour())->first();
    expect((float) $r9->avg_value)->toBe(15.0)->and($r9->samples)->toBe(2)->and(DB::table('metric_rollups')->count())->toBe(3);

    // Scheduler trễ 3 giờ: chạy bù 10, 11, 12 (+ tính lại 09).
    p11sample($a->server->id, null, 'cpu_pct', 30.0, Carbon::parse('2026-11-22 12:15:00', 'UTC'));
    $this->travelTo(Carbon::parse('2026-11-22 13:20:00', 'UTC'));
    expect(app(MetricsRollup::class)->run())->toBe(4);
    expect(DB::table('metric_rollups')->whereNull('hosting_account_id')->orderBy('bucket')->pluck('samples')->all())->toBe([3, 2, 1, 1]);
});

it('range > 24 giờ đọc rollup (trung bình theo số mẫu), ≤ 24 giờ đọc samples; tối đa 500 điểm', function () {
    $a = new Actors($this);
    $sid = $a->server->id;
    // Rollup không có samples tương ứng: chứng minh 7d đọc rollup. Hai giờ liền nhau nằm trong cùng một bước 3 giờ.
    $b = now()->utc()->subDays(2)->startOfDay()->addHours(3);
    DB::table('metric_rollups')->insert([
        ['server_id' => $sid, 'hosting_account_id' => null, 'metric' => 'cpu_pct', 'bucket' => $b,
            'min_value' => 1, 'avg_value' => 10, 'max_value' => 20, 'samples' => 60],
        ['server_id' => $sid, 'hosting_account_id' => null, 'metric' => 'cpu_pct', 'bucket' => $b->copy()->addHour(),
            'min_value' => 1, 'avg_value' => 40, 'max_value' => 50, 'samples' => 20],
    ]);
    p11sample($sid, null, 'cpu_pct', 77.0, now()->subMinutes(30));
    $sa = $a->spa('SA');
    $w = $sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}?metric=cpu_pct&range=7d");
    expect($w->json('data'))->toMatchArray(['source' => 'rollup', 'step_sec' => 3600])->and($w->json('data.points'))->toHaveCount(2);
    $m = $sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}?metric=cpu_pct&range=30d");
    // 30 ngày bước 3 giờ: hai giờ 03 và 04 gộp một điểm, trung bình theo số mẫu (10×60 + 40×20) / 80 = 17,5.
    expect($m->json('data.step_sec'))->toBe(10800)->and($m->json('data.points'))->toHaveCount(1)
        ->and($m->json('data.points.0.1'))->toEqual(17.5);
    $d = $sa->get("/api/v1/admin/metrics/servers/{$a->server->uuid}?metric=cpu_pct&range=24h");
    expect($d->json('data.source'))->toBe('samples')->and($d->json('data.points'))->toHaveCount(1)->and($d->json('data.points.0.1'))->toEqual(77);

    foreach (MetricsQuery::RANGES as [$span, $step]) {
        expect(intdiv($span, $step))->toBeLessThanOrEqual(500);
    }
});

it('itso:metrics-prune: tạo trước 2 ngày, chỉ drop partition quá 7 ngày, xóa rollup quá 90 ngày', function () {
    $a = new Actors($this);
    $this->travelTo(Carbon::parse('2026-11-22 01:00:00', 'UTC'));
    foreach (['2026-11-10', '2026-11-14', '2026-11-15', '2026-11-21'] as $day) {
        DB::select('SELECT itso_ensure_metric_partition(?::date)', [$day]);
    }
    DB::table('metric_rollups')->insert([
        ['server_id' => $a->server->id, 'hosting_account_id' => null, 'metric' => 'cpu_pct', 'bucket' => '2026-08-20 00:00:00+00',
            'min_value' => 1, 'avg_value' => 1, 'max_value' => 1, 'samples' => 1],
        ['server_id' => $a->server->id, 'hosting_account_id' => null, 'metric' => 'cpu_pct', 'bucket' => '2026-08-25 00:00:00+00',
            'min_value' => 1, 'avg_value' => 1, 'max_value' => 1, 'samples' => 1],
    ]);
    $this->artisan('itso:metrics-prune')->assertSuccessful();
    $parts = collect(DB::select("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'metric_samples'"))->pluck('relname')->sort()->values()->all();
    expect($parts)->toBe(['metric_samples_20261115', 'metric_samples_20261121', 'metric_samples_20261122', 'metric_samples_20261123',
        'metric_samples_20261124', 'metric_samples_default']);
    expect(DB::table('metric_rollups')->pluck('bucket')->map(fn ($b) => Carbon::parse($b)->utc()->toDateString())->all())->toBe(['2026-08-25']);
    // Chạy lại không lỗi, không đổi.
    $this->artisan('itso:metrics-prune')->assertSuccessful();
});
