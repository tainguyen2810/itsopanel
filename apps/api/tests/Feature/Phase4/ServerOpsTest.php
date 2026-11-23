<?php

use App\Domain\Servers\MetricsCollector;
use App\Models\AccountUsageSnapshot;
use App\Models\Agent;
use App\Models\Job;
use App\Models\ServerSoftware;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;
use Tests\Support\Spa;

// Prompt 4.5: server facts/platform, metrics, dịch vụ, phần mềm, reboot, usage snapshot, /system/updates.

const P4 = 'itso-admin-v1.yaml';

function p4agent(array $over = []): FakeAgent
{
    return new FakeAgent($over + [
        'system.ping' => fn () => ['pong' => true, 'agent_version' => '0.4.0', 'mode' => 'sandbox'],
        'system.info' => fn () => ['os' => 'Ubuntu 24.04.1 LTS', 'kernel' => '6.8.0-48-generic', 'hostname' => 'srv-test',
            'uptime_sec' => 3600, 'cpu_cores' => 4, 'ram_mb' => 8192, 'disk_total_mb' => 100000, 'disk_free_mb' => 60000,
            'cgroup_v2' => true, 'systemd' => true, 'quota_mode' => 'soft', 'arch' => 'amd64'],
        'metrics.snapshot' => fn () => ['cpu_pct' => 12.5, 'ram_used_mb' => 2048, 'disk_used_mb' => 40000, 'load_1m' => 0.7],
        'service.status' => fn (array $env) => ['services' => array_map(fn (string $n) => ['name' => $n,
            'active' => in_array($n, ['nginx', 'cron', 'ssh'], true), 'enabled' => $n !== 'fail2ban',
            'version' => $n === 'nginx' ? '1.24.0' : null], $env['params']['names'])],
        '*' => fn () => ['ok' => true],
    ]);
}

function p4local(Actors $a): void
{
    Agent::query()->create(['server_id' => $a->server->id, 'transport' => 'local']);
}

function p4idem(Spa $spa, string $uri): TestResponse
{
    return $spa->call('POST', $uri, [], ['Idempotency-Key' => (string) Str::uuid()]);
}

it('itso:metrics-collect ghi facts nền tảng, metric_samples, server_services, capacity; API khớp hợp đồng', function () {
    $a = new Actors($this);
    p4local($a);
    p4agent();
    $this->artisan('itso:metrics-collect')->assertSuccessful();
    $sa = $a->spa('SA');
    $id = $a->server->uuid;

    $s = $sa->get("/api/v1/admin/servers/$id");
    assertMatchesContract(P4, 'get', '/api/v1/admin/servers/{id}', 200, $s);
    expect($s->json('data.platform'))->toMatchArray(['quota_mode' => 'soft', 'cgroup_v2' => true, 'systemd' => true,
        'arch' => 'amd64', 'agent_mode' => 'sandbox'])
        ->and($s->json('data.resources'))->toMatchArray(['cpu_cores' => 4, 'ram_mb' => 8192, 'disk_mb' => 100000,
            'ram_used_mb' => 2048, 'disk_used_mb' => 40000, 'cpu_pct' => 12.5]);

    expect(DB::table('metric_samples')->whereNull('hosting_account_id')->pluck('metric')->sort()->values()->all())
        ->toBe(['cpu_pct', 'disk_pct', 'load_1m', 'ram_pct']);
    expect((float) DB::table('metric_samples')->where('metric', 'ram_pct')->value('value'))->toBe(25.0);

    $svc = $sa->get("/api/v1/admin/servers/$id/services");
    assertMatchesContract(P4, 'get', '/api/v1/admin/servers/{id}/services', 200, $svc);
    $nginx = collect($svc->json('data'))->firstWhere('name', 'nginx');
    expect($nginx)->toMatchArray(['active' => true, 'enabled' => true, 'version' => '1.24.0'])
        ->and(count($svc->json('data')))->toBe(count(MetricsCollector::SERVICES));

    $cap = $sa->get("/api/v1/admin/servers/$id/capacity");
    assertMatchesContract(P4, 'get', '/api/v1/admin/servers/{id}/capacity', 200, $cap);
    expect($cap->json('data'))->toMatchArray(['cpu_cores' => 4, 'account_count' => 1])
        ->and($cap->json('data.allocated_ram_mb'))->toBeGreaterThan(0);

    $m = $sa->get("/api/v1/admin/metrics/servers/$id?metric=cpu_pct&range=1h");
    assertMatchesContract(P4, 'get', '/api/v1/admin/metrics/servers/{id}', 200, $m);
    expect($m->json('data.step_sec'))->toBe(60)->and($m->json('data.points.0.1'))->toEqual(12.5);
    expect($sa->get("/api/v1/admin/metrics/servers/$id?metric=nope")->status())->toBe(422)
        ->and($sa->get("/api/v1/admin/metrics/servers/$id?metric=cpu_pct&range=2y")->status())->toBe(422);
});

it('agent không trả lời: metrics-collect báo lỗi, server degraded, platform giữ nguyên', function () {
    $a = new Actors($this);
    p4local($a);
    $agent = p4agent();
    $this->artisan('itso:metrics-collect')->assertSuccessful();
    $down = fn () => ['__error' => ['agent_unavailable', 'down', true]];
    $agent->on('system.ping', $down)->on('system.info', $down);
    $this->artisan('itso:metrics-collect')->assertFailed();
    $a->server->refresh();
    expect($a->server->status)->toBe('degraded')->and($a->server->observed_facts['platform']['quota_mode'])->toBe('soft');
});

it('dịch vụ: start/stop/restart qua job service.<action> (op service.control); ngoài allowlist hoặc hành động lạ → 422; trùng job → 409', function () {
    $a = new Actors($this);
    $agent = p4agent();
    $sa = $a->spa('SA');
    $id = $a->server->uuid;
    $r = p4idem($sa, "/api/v1/admin/servers/$id/services/nginx:restart");
    assertMatchesContract(P4, 'post', '/api/v1/admin/servers/{id}/services/{service}:{action}', 202, $r);
    expect($r->json('job.type'))->toBe('service.restart');
    $call = collect($agent->calls)->firstWhere('op', 'service.control');
    expect($call['params'])->toBe(['name' => 'nginx', 'action' => 'restart']);

    $bad = p4idem($sa, "/api/v1/admin/servers/$id/services/sshd:restart");
    assertMatchesContract(P4, 'post', '/api/v1/admin/servers/{id}/services/{service}:{action}', 422, $bad);
    expect(p4idem($sa, "/api/v1/admin/servers/$id/services/nginx:kill")->status())->toBe(422);

    Job::query()->update(['state' => 'running']);
    $busy = p4idem($sa, "/api/v1/admin/servers/$id/services/nginx:stop");
    assertMatchesContract(P4, 'post', '/api/v1/admin/servers/{id}/services/{service}:{action}', 409, $busy);
    expect(p4idem($sa, "/api/v1/admin/servers/$id/services/cron:stop")->status())->toBe(202);
});

it('phần mềm: catalog + trạng thái; cài qua job software.install ghi bản thật; gỡ gói nền tảng → 409; nâng cấp qua job', function () {
    $a = new Actors($this);
    $agent = p4agent(['software.install' => fn () => ['installed' => true, 'version' => '0.17.06-1', 'changed' => true],
        'software.upgrade' => fn () => ['from_version' => '0.17.06-1', 'version' => '0.17.06-2', 'changed' => true]]);
    $sa = $a->spa('SA');
    $id = $a->server->uuid;
    $l = $sa->get("/api/v1/admin/servers/$id/software");
    assertMatchesContract(P4, 'get', '/api/v1/admin/servers/{id}/software', 200, $l);
    expect(collect($l->json('data'))->pluck('key')->all())->toContain('acl', 'restic', 'stress-ng', 'php8.4', 'redis', 'valkey', 'docker', 'wp-cli')
        ->and(collect($l->json('data'))->firstWhere('key', 'stress-ng'))->toMatchArray(['state' => 'available', 'installed_version' => null]);

    $r = p4idem($sa, "/api/v1/admin/servers/$id/software/stress-ng:install");
    assertMatchesContract(P4, 'post', '/api/v1/admin/servers/{id}/software/{key}:{action}', 202, $r);
    expect(collect($agent->calls)->firstWhere('op', 'software.install')['params'])->toBe(['recipe' => 'stress-ng']);
    expect(ServerSoftware::query()->where('software_key', 'stress-ng')->first())
        ->status->toBe('ready')->version->toBe('0.17.06-1');
    expect(collect($sa->get("/api/v1/admin/servers/$id/software")->json('data'))->firstWhere('key', 'stress-ng'))
        ->toMatchArray(['state' => 'installed', 'installed_version' => '0.17.06-1']);

    $core = p4idem($sa, "/api/v1/admin/servers/$id/software/acl:remove");
    assertMatchesContract(P4, 'post', '/api/v1/admin/servers/{id}/software/{key}:{action}', 409, $core);
    expect(p4idem($sa, "/api/v1/admin/servers/$id/software/mysql:install")->status())->toBe(404);
    expect(p4idem($sa, "/api/v1/admin/servers/$id/software/stress-ng:upgrade")->status())->toBe(202);
    expect(ServerSoftware::query()->where('software_key', 'stress-ng')->value('version'))->toBe('0.17.06-2');

    expect(p4idem($sa, "/api/v1/admin/servers/$id/software/stress-ng:remove")->status())->toBe(202);
    expect(collect($sa->get("/api/v1/admin/servers/$id/software")->json('data'))->firstWhere('key', 'stress-ng')['state'])->toBe('available');
});

it('cài phần mềm thất bại → trạng thái failed; đang cài → 409', function () {
    $a = new Actors($this);
    p4agent(['software.install' => fn () => ['__error' => ['op_failed', 'apt-get install lỗi', false]]]);
    $sa = $a->spa('SA');
    $id = $a->server->uuid;
    p4idem($sa, "/api/v1/admin/servers/$id/software/stress-ng:install")->assertStatus(202);
    expect(ServerSoftware::query()->where('software_key', 'stress-ng')->value('status'))->toBe('failed');
    ServerSoftware::query()->update(['status' => 'provisioning']);
    expect(p4idem($sa, "/api/v1/admin/servers/$id/software/stress-ng:install")->status())->toBe(409);
});

it('reboot: cần step-up, job server.reboot gửi system.reboot trễ 60 giây', function () {
    $a = new Actors($this);
    $agent = p4agent();
    $r = p4idem($a->spa('SA'), "/api/v1/admin/servers/{$a->server->uuid}:reboot");
    assertMatchesContract(P4, 'post', '/api/v1/admin/servers/{id}:reboot', 202, $r);
    $p = collect($agent->calls)->firstWhere('op', 'system.reboot')['params'];
    expect($p['delay_sec'])->toBe(60)->and($p['reason'])->toStartWith('Yêu cầu từ panel');
});

it('itso:usage-refresh ghi account_usage_snapshots + metric theo account; usage và metrics account đọc lại', function () {
    $a = new Actors($this);
    p4agent(['quota.report' => fn (array $env) => ['usage' => array_map(fn (array $acc) => ['username' => $acc['username'],
        'disk_mb' => 512, 'inodes' => 99, 'cpu_pct' => 7.5, 'ram_mb' => 128], $env['params']['accounts'])]]);
    $this->artisan('itso:usage-refresh')->assertSuccessful();
    expect(AccountUsageSnapshot::query()->where('hosting_account_id', $a->account->id)->count())->toBe(1);
    $sa = $a->spa('SA');
    $u = $sa->get("/api/v1/admin/hosting-accounts/{$a->account->uuid}/usage");
    assertMatchesContract(P4, 'get', '/api/v1/admin/hosting-accounts/{id}/usage', 200, $u);
    expect($u->json('data.disk_mb.used'))->toBe(512)->and($u->json('data.cpu_percent.used'))->toEqual(7.5);
    $m = $sa->get("/api/v1/admin/metrics/hosting-accounts/{$a->account->uuid}?metric=disk_pct&range=24h");
    assertMatchesContract(P4, 'get', '/api/v1/admin/metrics/hosting-accounts/{id}', 200, $m);
    expect($m->json('data.points'))->toHaveCount(1)->and($m->json('data.step_sec'))->toBe(300);
    expect($sa->get("/api/v1/admin/metrics/hosting-accounts/{$a->account->uuid}?metric=load_1m")->status())->toBe(422);
});

it('prune xóa partition metric_samples cũ hơn 7 ngày', function () {
    DB::select("SELECT itso_ensure_metric_partition((now() - interval '10 days')::date)");
    DB::select('SELECT itso_ensure_metric_partition(now()::date)');
    $n = app(MetricsCollector::class)->prune();
    $left = collect(DB::select("SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'metric_samples'"))->pluck('relname');
    expect($n)->toBe(1)->and($left)->toContain('metric_samples_default', 'metric_samples_'.now()->utc()->format('Ymd'))->toHaveCount(2);
});

it('/system/updates: phiên bản hiện tại, release còn giữ (đọc thư mục), lệnh cập nhật', function () {
    $a = new Actors($this);
    $dir = sys_get_temp_dir().'/itso-rel-'.Str::random(6);
    foreach (['0.3.0', '0.4.0', 'tmp-broken'] as $v) {
        mkdir("$dir/releases/$v", 0o755, true);
    }
    touch("$dir/releases/0.3.0/.complete");
    touch("$dir/releases/0.4.0/.complete");
    symlink('releases/0.4.0', "$dir/current");
    config(['itso.releases_dir' => "$dir/releases", 'itso.current_link' => "$dir/current", 'itso.version' => '0.4.0',
        'itso.update_state_dir' => "$dir/state"]);
    $sa = $a->spa('SA');
    $r = $sa->get('/api/v1/admin/system/updates');
    assertMatchesContract(P4, 'get', '/api/v1/admin/system/updates', 200, $r);
    expect($r->json('data'))->toMatchArray(['current_version' => '0.4.0', 'channel' => 'stable', 'update_available' => false,
        'journal' => null, 'history' => [], 'repair_command' => 'sudo itso repair --fix'])
        ->and($r->json('data.releases'))->toBe([['version' => '0.4.0', 'active' => true], ['version' => '0.3.0', 'active' => false]])
        ->and($r->json('data.update_command'))->toStartWith('sudo itso update');

    // Phase 12 (D-113): journal dở do agent ghi + lịch sử jsonl (dòng hỏng bị bỏ, mới nhất trước).
    mkdir("$dir/state");
    file_put_contents("$dir/state/update.journal", json_encode(['version_from' => '0.4.0', 'version_to' => '0.5.0',
        'step' => 'migrated', 'started_at' => now()->subHour()->toIso8601String()]));
    file_put_contents("$dir/state/update-history.jsonl", implode("\n", [
        json_encode(['action' => 'update', 'version_from' => '0.3.0', 'version_to' => '0.4.0', 'result' => 'succeeded',
            'started_at' => '2026-11-20T01:00:00Z', 'finished_at' => '2026-11-20T01:02:00Z', 'duration_sec' => 120, 'by' => 'cli', 'note' => null]),
        '{hỏng',
        json_encode(['action' => 'rollback', 'version_from' => '0.4.0', 'version_to' => '0.3.0', 'result' => 'failed',
            'started_at' => '2026-11-21T01:00:00Z', 'finished_at' => null, 'duration_sec' => null, 'by' => 'cli', 'note' => 'thử']),
    ])."\n");
    $r = $sa->get('/api/v1/admin/system/updates');
    assertMatchesContract(P4, 'get', '/api/v1/admin/system/updates', 200, $r);
    expect($r->json('data.journal'))->toMatchArray(['version_to' => '0.5.0', 'step' => 'migrated', 'interrupted' => true])
        ->and($r->json('data.journal.hint'))->toContain('repair --fix')
        ->and(array_column($r->json('data.history'), 'action'))->toBe(['rollback', 'update']);
});
