<?php

use App\Models\AuditLog;
use App\Models\Job;
use App\Models\PhpVersion;
use App\Models\ServerSoftware;
use App\Models\SoftwareCatalog;
use App\Models\Website;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;
use Tests\Support\Spa;

// Prompt 10.2: Software Manager (D-100, ADR 0045).

const P10S = 'itso-admin-v1.yaml';

function p10sw(Spa $spa, string $uri, string $method = 'POST', array $body = []): TestResponse
{
    return $spa->call($method, $uri, $body, ['Idempotency-Key' => (string) Str::uuid()]);
}

function p10installed(Actors $a, string $key, string $ver = '1.0'): void
{
    ServerSoftware::query()->create(['server_id' => $a->server->id, 'software_key' => $key, 'version' => $ver,
        'status' => 'ready', 'state' => 'installed', 'spec_version' => 1, 'observed_version' => 1]);
}

it('cài: xung đột redis ↔ valkey → 409 conflict; thiếu phụ thuộc → 422; PHP bản PPA cài qua job và hiện ở PHP Manager', function () {
    $a = new Actors($this);
    $agent = new FakeAgent(['software.install' => fn (array $e) => ['installed' => true, 'version' => '8.4.2-1+ubuntu24.04.1', 'changed' => true]]);
    $sa = $a->spa('SA');
    $id = $a->server->uuid;
    p10installed($a, 'redis', '7.0.15');

    $c = p10sw($sa, "/api/v1/admin/servers/$id/software/valkey:install");
    assertMatchesContract(P10S, 'post', '/api/v1/admin/servers/{id}/software/{key}:{action}', 409, $c);
    expect($c->json('code'))->toBe('conflict')->and($c->json('detail'))->toContain('redis');
    $dep = p10sw($sa, "/api/v1/admin/servers/$id/software/composer:install");
    assertMatchesContract(P10S, 'post', '/api/v1/admin/servers/{id}/software/{key}:{action}', 422, $dep);
    expect($dep->json('detail'))->toContain('php8.3');
    expect(p10sw($sa, "/api/v1/admin/servers/$id/software/redis:install")->status())->toBe(409); // đã cài
    expect($agent->ops())->not->toContain('software.install');

    p10sw($sa, "/api/v1/admin/servers/$id/software/php8.4:install")->assertStatus(202);
    expect(collect($agent->calls)->firstWhere('op', 'software.install')['params'])->toBe(['recipe' => 'php8.4']);
    expect(PhpVersion::query()->where('server_id', $a->server->id)->where('version', '8.4')->value('status'))->toBe('ready');
    $php = collect($sa->get("/api/v1/admin/servers/$id/php-versions")->json('data'))->firstWhere('version', '8.4');
    expect($php['installed'])->toBeTrue();
    expect(AuditLog::query()->where('action', 'software.install')->exists())->toBeTrue();
});

it('gỡ bị chặn khi đang dùng: PHP có website, Docker có compose project, phần mềm khác phụ thuộc; lõi không gỡ được', function () {
    $a = new Actors($this);
    $agent = new FakeAgent(['*' => fn () => ['installed' => false, 'changed' => true]]);
    $sa = $a->spa('SA');
    $id = $a->server->uuid;
    foreach (['php8.2', 'docker', 'php8.3', 'composer', 'memcached'] as $k) {
        p10installed($a, $k);
    }
    Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'primary_domain' => 'demo.vn',
        'status' => 'ready', 'php_version' => '8.2']);
    DB::table('compose_projects')->insert(['server_id' => $a->server->id, 'name' => 'cache']);

    $list = $sa->get("/api/v1/admin/servers/$id/software");
    assertMatchesContract(P10S, 'get', '/api/v1/admin/servers/{id}/software', 200, $list);
    $php = collect($list->json('data'))->firstWhere('key', 'php8.2');
    expect($php['in_use'])->toContain(['kind' => 'website', 'count' => 1])->and($php['remove_blocked'])->toContain('1 website');
    expect(collect($list->json('data'))->firstWhere('key', 'docker')['remove_blocked'])->toContain('compose project');
    expect(collect($list->json('data'))->firstWhere('key', 'memcached')['remove_blocked'])->toBeNull();

    foreach (['php8.2' => 'website', 'docker' => 'compose project', 'php8.3' => 'lõi', 'nginx' => 'lõi'] as $k => $why) {
        if ($k === 'nginx') {
            p10installed($a, 'nginx');
        }
        $r = p10sw($sa, "/api/v1/admin/servers/$id/software/$k:remove");
        assertMatchesContract(P10S, 'post', '/api/v1/admin/servers/{id}/software/{key}:{action}', 409, $r);
        expect($r->json('code'))->toBe('resource_locked')->and(mb_strtolower((string) $r->json('detail')))->toContain($why);
    }
    // composer phụ thuộc php8.3 (lõi) — memcached gỡ được.
    expect(p10sw($sa, "/api/v1/admin/servers/$id/software/memcached:remove")->status())->toBe(202);
    expect($agent->ops())->toBe(['software.remove']);
    expect(p10sw($sa, "/api/v1/admin/servers/$id/software/valkey:remove")->status())->toBe(409); // chưa cài
});

it('ma trận quyền: ADMIN ngoài phạm vi 404, USER không vào admin; os-updates chỉ SA đổi, không bao giờ auto_reboot', function () {
    $a = new Actors($this);
    $agent = new FakeAgent(['os.auto_updates' => fn (array $e) => $e['params'] + ['auto_reboot' => false, 'changed' => true]]);
    $id = $a->server->uuid;
    expect($a->spa('AD_OUT')->get("/api/v1/admin/servers/$id/software")->status())->toBe(404);
    expect(p10sw($a->spa('AD_IN'), "/api/v1/admin/servers/$id/software/memcached:install")->status())->toBe(403); // software.write chỉ SA
    $in = $a->spa('AD_IN');
    $g = $in->get("/api/v1/admin/servers/$id/os-updates");
    assertMatchesContract(P10S, 'get', '/api/v1/admin/servers/{id}/os-updates', 200, $g);
    expect($g->json('data'))->toMatchArray(['enabled' => false, 'security_only' => true, 'auto_reboot' => false]);
    expect(p10sw($in, "/api/v1/admin/servers/$id/os-updates", 'PUT', ['enabled' => true])->status())->toBe(403);

    $sa = $a->spa('SA');
    $r = p10sw($sa, "/api/v1/admin/servers/$id/os-updates", 'PUT', ['enabled' => true, 'security_only' => true]);
    assertMatchesContract(P10S, 'put', '/api/v1/admin/servers/{id}/os-updates', 202, $r);
    expect(collect($agent->calls)->firstWhere('op', 'os.auto_updates')['params'])->toBe(['enabled' => true, 'security_only' => true]);
    expect(Job::query()->where('type', 'software.os_updates')->value('state'))->toBe('succeeded');
    expect($sa->get("/api/v1/admin/servers/$id/os-updates")->json('data'))->toMatchArray(['enabled' => true, 'auto_reboot' => false]);
    expect(p10sw($sa, "/api/v1/admin/servers/$id/os-updates", 'PUT', ['enabled' => 'yes'])->status())->toBe(422);
});

it('itso:software-refresh đồng bộ catalog + bản mới từ agent; bản mới hơn → upgradable', function () {
    $a = new Actors($this);
    p10installed($a, 'redis', '7.0.15');
    new FakeAgent([
        'software.catalog' => fn () => ['recipes' => [['recipe' => 'redis', 'name' => 'Redis', 'category' => 'cache', 'packages' => ['redis-server'],
            'source' => 'ubuntu', 'service' => 'redis-server', 'core' => false, 'conflicts' => ['valkey'], 'requires' => []]]],
        'software.status' => fn () => ['software' => [
            ['recipe' => 'redis', 'installed_version' => '7.0.15', 'latest_version' => '7.0.16', 'service' => 'redis-server', 'active' => true],
            ['recipe' => 'memcached', 'installed_version' => null, 'latest_version' => '1.6.24', 'service' => 'memcached', 'active' => null],
        ], 'pending_security' => 3],
    ]);
    $this->artisan('itso:software-refresh')->assertSuccessful();
    expect(ServerSoftware::query()->where('software_key', 'redis')->first())
        ->upgrade_available->toBeTrue()->latest_version->toBe('7.0.16')->state->toBe('upgradable');
    expect(ServerSoftware::query()->where('software_key', 'memcached')->exists())->toBeFalse();
    expect(SoftwareCatalog::query()->where('key', 'redis')->value('service'))->toBe('redis-server');
    $sa = $a->spa('SA');
    $id = $a->server->uuid;
    expect(collect($sa->get("/api/v1/admin/servers/$id/software")->json('data'))->firstWhere('key', 'redis'))
        ->toMatchArray(['state' => 'upgradable', 'latest_version' => '7.0.16']);
    expect($sa->get("/api/v1/admin/servers/$id/os-updates")->json('data.pending_security'))->toBe(3);
});

it('website chọn PHP theo bản đã cài và gói cho phép', function () {
    $a = new Actors($this);
    new FakeAgent(['*' => fn () => ['ok' => true]]);
    PhpVersion::query()->create(['server_id' => $a->server->id, 'version' => '8.4', 'status' => 'ready', 'extensions' => []]);
    // Phiên bản gói bất biến: tạo bản mới chỉ cho PHP 8.3 rồi gán cho account.
    $pv = $a->account->packageVersion->replicate(['uuid']);
    $pv->version = $pv->version + 1;
    $pv->php_versions = ['8.3'];
    $pv->save();
    $a->account->forceFill(['package_version_id' => $pv->id])->save();
    $sa = $a->spa('SA');
    $r = p10sw($sa, '/api/v1/admin/websites', 'POST', ['hosting_account_uuid' => $a->account->uuid, 'primary_domain' => 'php84.vn',
        'type' => 'php', 'php_version' => '8.4']);
    expect($r->status())->toBe(409)->and($r->json('detail'))->toContain('Gói hosting');
});
