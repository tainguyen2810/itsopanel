<?php

use App\Models\AuditLog;
use App\Models\BackupDestination;
use App\Models\BackupSnapshot;
use App\Models\ComposeProject;
use App\Models\ComposeRevision;
use App\Models\DockerHost;
use App\Models\ImageRollback;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\PortAllocation;
use App\Models\Registry;
use App\Models\Website;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;
use Tests\Support\Spa;

require_once __DIR__.'/../Phase8/helpers.php';

// Prompt 10.4: Panel Docker (D-94…D-98) — bật Docker, compose project + validator + cổng, registry, website docker,
// firewall scope=docker, backup/khôi phục volume. Mọi params/result op được kiểm theo contracts/agent-ops.

const P10D = 'itso-admin-v1.yaml';

function p10dk(Spa $spa, string $method, string $uri, array $body = [], array $headers = []): TestResponse
{
    return $spa->call($method, $uri, $body, $headers + ['Idempotency-Key' => (string) Str::uuid()]);
}

/**
 * Validator giả bám hành vi compose.validate: privileged/docker.sock bị chặn (privileged override được), mỗi dòng `- "<cổng>"`
 * nhận một cổng trong allocated_ports theo thứ tự, volume có tên → itso_<uuid>_<tên>.
 */
function p10validator(?callable $before = null): callable
{
    return function (array $e) use ($before): array {
        if ($before !== null) {
            $before($e);
        }
        $p = $e['params'];
        $y = (string) $p['compose_yaml'];
        $over = array_column($p['overrides'], 'rule');
        $f = [];
        if (str_contains($y, 'privileged: true') && ! in_array('privileged', $over, true)) {
            $f[] = ['rule' => 'privileged', 'severity' => 'error', 'service' => 'app', 'path' => 'services.app.privileged',
                'message' => 'privileged bị cấm', 'overridable' => true];
        }
        if (str_contains($y, 'docker.sock')) {
            $f[] = ['rule' => 'docker_socket', 'severity' => 'error', 'service' => 'app', 'path' => 'services.app.volumes[0]',
                'message' => 'Không mount Docker socket', 'overridable' => false];
        }
        preg_match_all('/- "(\d+)"/', $y, $m);
        $ports = [];
        foreach ($m[1] as $i => $c) {
            if (! isset($p['allocated_ports'][$i])) {
                $f[] = ['rule' => 'services', 'severity' => 'error', 'service' => 'app', 'path' => 'services.app.ports', 'message' => 'thiếu cổng', 'overridable' => false];
                break;
            }
            $ports[] = ['service' => 'app', 'container_port' => (int) $c, 'host_port' => $p['allocated_ports'][$i], 'protocol' => 'tcp'];
        }
        preg_match_all('/image: (\S+)/', $y, $im);
        preg_match_all('/^  ([a-z][a-z0-9-]*): \{\}$/m', explode("\nvolumes:\n", $y)[1] ?? '', $vm);
        $ok = $f === [];
        $vy = $ok ? $y."# validated\n" : null;

        return ['ok' => $ok, 'findings' => $f, 'rewrites' => $ports === [] ? [] : [['service' => 'app', 'path' => 'services.app.ports[0]',
            'before' => $m[1][0], 'after' => '127.0.0.1:'.$ports[0]['host_port'].':'.$ports[0]['container_port'].'/tcp']],
            'ports' => $ok ? $ports : [], 'images' => $im[1],
            'volumes' => array_map(fn ($v) => 'itso_'.$p['project']['project_uuid'].'_'.$v, $vm[1]),
            'validated_yaml' => $vy, 'validated_sha256' => $ok ? hash('sha256', (string) $vy) : null];
    };
}

/**
 * Agent giả: như p8agent (kiểm params/result theo contracts) nhưng giữ object rỗng ({}), vì FakeAgent giải mã JSON
 * thành mảng PHP nên `{}` thành `[]`.
 *
 * @param  array<string, callable>  $over
 */
function p10dagent(array &$errors, array $over = []): FakeAgent
{
    $handlers = [];
    foreach ($over + p10dbase() as $op => $h) {
        $handlers[$op] = function (array $env) use ($op, $h, &$errors) {
            $params = $env['params'] === [] ? new stdClass : $env['params'];
            if (is_array($params) && ($params['env'] ?? null) === []) {
                $params['env'] = new stdClass;
            }
            if (($e = p8schema($op, $params, 'params')) !== null) {
                $errors[] = $e;
            }
            $out = $h($env);
            if (! isset($out['__error']) && ($e = p8schema($op, $out, 'result')) !== null) {
                $errors[] = $e;
            }

            return $out;
        };
    }
    $handlers['*'] = fn () => ['ok' => true];

    return new FakeAgent($handlers);
}

/** @return array<string, callable> */
function p10dbase(): array
{
    $snap = fn () => bin2hex(random_bytes(8));

    return [
        'backup.repo.init' => fn () => ['initialized' => true, 'already_existed' => false],
        'backup.stats' => fn () => ['raw_size_bytes' => 5242880, 'restore_size_bytes' => 6291456, 'snapshots' => 2],
        'fs.site_layout.ensure' => fn () => ['path' => '/home/x/sites/kuma.vn', 'created' => true],
        'software.install' => fn () => ['installed' => true, 'version' => '26.1.3-0ubuntu1', 'changed' => true],
        'docker.host.configure' => fn () => ['changed' => true, 'restarted' => true, 'removed_group_members' => []],
        'docker.firewall.sync' => fn (array $e) => ['rules' => count($e['params']['open_ports']) + 4, 'changed' => true],
        'docker.host.status' => fn () => ['installed' => true, 'engine_version' => '26.1.3', 'compose_version' => '2.27.1', 'api_version' => '1.45',
            'checks' => [['key' => 'daemon_json', 'ok' => true, 'detail' => 'ok'], ['key' => 'docker_group_empty', 'ok' => true, 'detail' => 'ok']],
            'docker_group_members' => [], 'counts' => ['containers' => 1, 'running' => 1, 'images' => 2, 'volumes' => 1, 'projects' => 1]],
        'compose.validate' => p10validator(),
        'compose.apply' => fn () => ['services' => [['service' => 'app', 'state' => 'running', 'container_id' => str_repeat('a', 64)]]],
        'compose.remove' => fn () => ['removed' => true, 'volumes_removed' => []],
        'compose.up' => fn () => ['running' => 1, 'total' => 1],
        'compose.down' => fn () => ['stopped' => 1],
        'docker.registry.login' => fn () => ['ok' => true, 'message' => 'Login Succeeded'],
        'docker.container.list' => fn () => ['containers' => []],
        'docker.image.update' => fn (array $e) => ['services' => [['service' => 'app', 'from_digest' => 'sha256:'.str_repeat('1', 64),
            'to_digest' => 'sha256:'.str_repeat('2', 64), 'state' => 'updated', 'rollback_tag' => 'itso-rollback/x-app:20261122010000', 'reason' => null]]],
        'docker.image.rollback' => fn () => ['services' => [['service' => 'app', 'digest' => 'sha256:'.str_repeat('1', 64)]]],
        'docker.volume.backup' => fn () => ['snapshot_id' => $snap(), 'size_bytes' => 4096, 'paused' => []],
        'docker.volume.restore' => fn (array $e) => ['restored' => true, 'volume' => $e['params']['target']],
        'nginx.vhost.apply' => fn () => ['config_path' => '/etc/nginx/sites-enabled/x.conf', 'nginx_test' => 'ok', 'reloaded' => true, 'changed' => true],
    ];
}

function p10enabled(Actors $a): void
{
    DockerHost::query()->create(['server_id' => $a->server->id, 'enabled' => true, 'state' => 'enabled', 'observed_at' => now()]);
}

const P10YAML = "services:\n  app:\n    image: nginx:1.27\n    ports:\n      - \"80\"\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n";

it('bật Docker: SA + step-up → software.install → daemon.json → DOCKER-USER; ADMIN không bật được; trạng thái khớp contract', function () {
    $errors = [];
    $agent = p10dagent($errors);
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $id = $a->server->uuid;

    expect($sa->get("/api/v1/admin/servers/$id/docker")->json('data.state'))->toBe('not_installed');
    assertMatchesContract(P10D, 'post', '/api/v1/admin/servers/{id}/docker:enable', 403, p10dk($a->spa('AD_IN'), 'POST', "/api/v1/admin/servers/$id/docker:enable"));
    $r = p10dk($sa, 'POST', "/api/v1/admin/servers/$id/docker:enable");
    assertMatchesContract(P10D, 'post', '/api/v1/admin/servers/{id}/docker:enable', 202, $r);
    expect($agent->ops())->toBe(['software.install', 'docker.host.configure', 'docker.firewall.sync'])
        ->and($agent->calls[0]['params'])->toBe(['recipe' => 'docker'])
        ->and($agent->calls[2]['params']['public_interface'])->toBe('eth0');
    $h = DockerHost::query()->findOrFail($a->server->id);
    expect($h->enabled)->toBeTrue()->and($h->state)->toBe('enabled')->and($h->firewall_synced_at)->not->toBeNull();

    $show = $sa->get("/api/v1/admin/servers/$id/docker");
    assertMatchesContract(P10D, 'get', '/api/v1/admin/servers/{id}/docker', 200, $show);
    expect($show->json('data.engine_version'))->toBe('26.1.3')->and($show->json('data.daemon.userland_proxy'))->toBeFalse()
        ->and($show->json('data.counts.images'))->toBe(2);
    assertMatchesContract(P10D, 'get', '/api/v1/admin/servers/{id}/docker', 200, $a->spa('AD_IN')->get("/api/v1/admin/servers/$id/docker"));
    expect(AuditLog::query()->where('action', 'docker.enable')->exists())->toBeTrue()->and($errors)->toBe([]);
});

it('validator chặn → 422, không tạo project, không apply; sửa YAML bị chặn → lưu revision lỗi, revision hiện hành giữ nguyên', function () {
    $errors = [];
    $agent = p10dagent($errors);
    $a = new Actors($this);
    p10enabled($a);
    $sa = $a->spa('SA');

    $bad = p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'evil',
        'compose_yaml' => "services:\n  app:\n    image: nginx:1.27\n    privileged: true\n"]);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/compose-projects', 422, $bad);
    expect($bad->json('errors.compose_yaml.0'))->toContain('privileged')
        ->and(ComposeProject::query()->count())->toBe(0)->and($agent->ops())->not->toContain('compose.apply');

    $ok = p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'web', 'compose_yaml' => P10YAML,
        'env' => ['APP_KEY' => 'k-123']]);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/compose-projects', 202, $ok);
    expect(array_slice($agent->ops(), -2))->toBe(['compose.validate', 'compose.apply']);
    $apply = collect($agent->calls)->last(fn ($c) => $c['op'] === 'compose.apply');
    expect($apply['params']['env'])->toBe(['APP_KEY' => 'k-123'])->and($apply['params']['ports'][0]['host_port'])->toBe(20000);
    // Biến môi trường tới agent qua tham chiếu bí mật: không nằm trong job_steps/audit.
    expect(p8leak('k-123'))->toBeNull();
    $p = ComposeProject::query()->firstOrFail();
    expect($p->run_state)->toBe('running')->and($p->status)->toBe('ready');
    $show = $sa->get("/api/v1/admin/compose-projects/{$p->uuid}");
    assertMatchesContract(P10D, 'get', '/api/v1/admin/compose-projects/{id}', 200, $show);
    expect($show->json('data.ports.0.host_port'))->toBe(20000)->and($show->json('data.volumes.0'))->toBe("itso_{$p->uuid}_data");

    $n = count($agent->calls);
    $edit = p10dk($sa, 'PATCH', "/api/v1/admin/compose-projects/{$p->uuid}", ['compose_yaml' => "services:\n  app:\n    image: nginx:1.27\n    volumes:\n      - /var/run/docker.sock:/s\n"]);
    assertMatchesContract(P10D, 'patch', '/api/v1/admin/compose-projects/{id}', 422, $edit);
    expect(array_slice($agent->ops(), $n))->toBe(['compose.validate']);
    $p->refresh();
    expect($p->currentRevision?->number)->toBe(1)
        ->and(ComposeRevision::query()->where('project_id', $p->id)->where('ok', false)->value('findings_count'))->toBe(1);
    $revs = $sa->get("/api/v1/admin/compose-projects/{$p->uuid}/revisions");
    assertMatchesContract(P10D, 'get', '/api/v1/admin/compose-projects/{id}/revisions', 200, $revs);
    expect(array_column($revs->json('data'), 'current'))->toBe([false, true]);

    $prev = p10dk($sa, 'POST', '/api/v1/admin/compose-projects:validate', ['server_uuid' => $a->server->uuid,
        'compose_yaml' => "services:\n  app:\n    image: nginx:1.27\n    privileged: true\n"]);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/compose-projects:validate', 200, $prev);
    expect($prev->json('data.ok'))->toBeFalse()->and($prev->json('data.findings.0.overridable'))->toBeTrue();
    expect(AuditLog::query()->where('action', 'compose.validate_rejected')->count())->toBe(2)->and($errors)->toBe([]);
});

it('override: ADMIN gửi → 403; SA kèm lý do → chạy được, revision và audit ghi lý do; ADMIN sửa YAML không mang override cũ theo', function () {
    $errors = [];
    $agent = p10dagent($errors);
    $a = new Actors($this);
    p10enabled($a);
    $priv = "services:\n  app:\n    image: nginx:1.27\n    privileged: true\n";
    $ov = [['rule' => 'privileged', 'reason' => 'Cần truy cập thiết bị USB cho máy quét']];

    $ad = p10dk($a->spa('AD_IN'), 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'scan',
        'compose_yaml' => $priv, 'overrides' => $ov]);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/compose-projects', 403, $ad);
    expect($agent->ops())->toBe([]);
    $prev = p10dk($a->spa('AD_IN'), 'POST', '/api/v1/admin/compose-projects:validate', ['server_uuid' => $a->server->uuid,
        'compose_yaml' => $priv, 'overrides' => $ov]);
    expect($prev->status())->toBe(403);

    $sa = $a->spa('SA');
    expect(p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'scan', 'compose_yaml' => $priv,
        'overrides' => [['rule' => 'privileged', 'reason' => 'ngắn']]])->status())->toBe(422);
    expect(p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'scan', 'compose_yaml' => $priv,
        'overrides' => [['rule' => 'docker_socket', 'reason' => 'Lý do đủ dài nhưng rule không override được']]])->status())->toBe(422);
    p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'scan', 'compose_yaml' => $priv,
        'overrides' => $ov])->assertStatus(202);
    $p = ComposeProject::query()->where('name', 'scan')->firstOrFail();
    $apply = collect($agent->calls)->last(fn ($c) => $c['op'] === 'compose.validate');
    expect($apply['params']['overrides'][0])->toMatchArray(['rule' => 'privileged', 'by_user_uuid' => $a->sa->uuid]);
    $show = $sa->get("/api/v1/admin/compose-projects/{$p->uuid}");
    expect($show->json('data.validation.overrides.0.reason'))->toBe($ov[0]['reason'])->and($show->json('data.validation.overrides.0.by.uuid'))->toBe($a->sa->uuid);
    expect(json_encode(AuditLog::query()->where('action', 'compose.create')->value('changes')))->toContain('USB');

    // ADMIN sửa YAML → override của SA không áp sang YAML mới → validator chặn lại.
    $ad = p10dk($a->spa('AD_IN'), 'PATCH', "/api/v1/admin/compose-projects/{$p->uuid}", ['compose_yaml' => $priv."    mem_limit: 128m\n"]);
    expect($ad->status())->toBe(422)->and($ad->json('errors.compose_yaml.0'))->toContain('privileged');
    expect(p10dk($a->spa('AD_IN'), 'PATCH', "/api/v1/admin/compose-projects/{$p->uuid}", ['overrides' => $ov])->status())->toBe(403);
    expect($errors)->toBe([]);
});

it('cấp cổng: không trùng khi 2 project tạo song song (đụng unique → kiểm lại), xóa project trả cổng và tên', function () {
    $errors = [];
    $a = new Actors($this);
    p10enabled($a);
    $raced = false;
    // Lúc project "b" đang kiểm YAML, một project khác giữ mất cổng 20001 (commit trước) → insert của "b" đụng unique.
    $agent = p10dagent($errors, ['compose.validate' => p10validator(function (array $e) use (&$raced, $a): void {
        if ($e['params']['project']['name'] === 'b' && ! $raced) {
            $raced = true;
            $other = ComposeProject::query()->where('name', 'a')->firstOrFail();
            PortAllocation::query()->create(['server_id' => $a->server->id, 'port' => $e['params']['allocated_ports'][0], 'protocol' => 'tcp',
                'compose_project_id' => $other->id, 'service' => 'side', 'container_port' => 81]);
        }
    })]);
    $sa = $a->spa('SA');
    foreach (['a', 'b'] as $name) {
        p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => $name, 'compose_yaml' => P10YAML])
            ->assertStatus(202);
    }
    $rows = PortAllocation::query()->orderBy('port')->get(['port', 'compose_project_id', 'service']);
    expect($rows->pluck('port')->all())->toBe([20000, 20001, 20002])->and($raced)->toBeTrue();
    $b = ComposeProject::query()->where('name', 'b')->firstOrFail();
    expect(PortAllocation::query()->where('compose_project_id', $b->id)->value('port'))->toBe(20002)
        ->and(collect($agent->calls)->filter(fn ($c) => $c['op'] === 'compose.validate' && $c['params']['project']['name'] === 'b')->count())->toBe(3);
    $list = $sa->get("/api/v1/admin/servers/{$a->server->uuid}/docker/port-allocations");
    assertMatchesContract(P10D, 'get', '/api/v1/admin/servers/{id}/docker/port-allocations', 200, $list);

    // Sửa compose giữ nguyên cổng đã cấp (cổng của chính project là ứng viên đầu).
    p10dk($sa, 'PATCH', "/api/v1/admin/compose-projects/{$b->uuid}", ['compose_yaml' => P10YAML."# v2\n"])->assertStatus(202);
    expect(PortAllocation::query()->where('compose_project_id', $b->id)->pluck('port')->all())->toBe([20002]);

    // Xóa project → compose.remove → trả cổng, tên dùng lại được.
    $del = p10dk($sa, 'DELETE', "/api/v1/admin/compose-projects/{$b->uuid}");
    assertMatchesContract(P10D, 'delete', '/api/v1/admin/compose-projects/{id}', 202, $del);
    expect(collect($agent->calls)->last()['params'])->toMatchArray(['remove_volumes' => false]);
    expect(PortAllocation::query()->where('compose_project_id', $b->id)->count())->toBe(0)
        ->and(ComposeProject::query()->where('id', $b->id)->exists())->toBeFalse();
    p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'b', 'compose_yaml' => P10YAML])
        ->assertStatus(202);
    expect(PortAllocation::query()->where('compose_project_id', ComposeProject::query()->where('name', 'b')->value('id'))->value('port'))->toBe(20002);
    expect($errors)->toBe([]);
});

it('registry: mật khẩu không lộ ở API, params job, log, audit; compose dùng image registry → đăng nhập qua secret_ref', function () {
    $errors = [];
    $agent = p10dagent($errors);
    $a = new Actors($this);
    p10enabled($a);
    $sa = $a->spa('SA');
    $secret = 'ghp_S3cretT0ken-XYZ';

    assertMatchesContract(P10D, 'post', '/api/v1/admin/registries', 403, $a->spa('AD_IN')->post('/api/v1/admin/registries',
        ['name' => 'x', 'url' => 'https://ghcr.io']));
    $r = $sa->post('/api/v1/admin/registries', ['name' => 'GHCR', 'url' => 'https://ghcr.io', 'username' => 'itso-bot', 'password' => $secret]);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/registries', 201, $r);
    expect(json_encode($r->json()))->not->toContain($secret)->and($r->json('data'))->not->toHaveKey('password');
    expect($sa->post('/api/v1/admin/registries', ['name' => 'Sai', 'url' => 'http://ghcr.io'])->status())->toBe(422);
    $list = $sa->get('/api/v1/admin/registries');
    assertMatchesContract(P10D, 'get', '/api/v1/admin/registries', 200, $list);
    expect(json_encode($list->json()))->not->toContain($secret);
    $reg = Registry::query()->firstOrFail();

    $t = p10dk($sa, 'POST', "/api/v1/admin/registries/{$reg->uuid}:test");
    assertMatchesContract(P10D, 'post', '/api/v1/admin/registries/{id}:test', 202, $t);
    expect($agent->calls[0]['params']['password'])->toBe($secret); // chỉ bản gửi agent mới có giá trị thật
    expect(JobStep::query()->where('op', 'docker.registry.login')->value('params_redacted')['password'])->toBe(['$secret' => 'registry_password:'.$reg->uuid]);
    expect($reg->refresh()->last_test_ok)->toBeTrue();

    p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'priv',
        'compose_yaml' => "services:\n  app:\n    image: ghcr.io/itso/app:1.2\n"])->assertStatus(202);
    $ops = array_slice($agent->ops(), 1);
    expect($ops)->toBe(['compose.validate', 'compose.validate', 'docker.registry.login', 'compose.apply'])
        ->and(collect($agent->calls)->last()['params']['registry_uuids'])->toBe([$reg->uuid]);
    expect(p8leak($secret))->toBeNull()->and($errors)->toBe([]);
    expect($sa->call('DELETE', "/api/v1/admin/registries/{$reg->uuid}")->status())->toBe(204);
});

it('USER/Portal không có route Docker nào; ADMIN ngoài phạm vi → 404; ADMIN trong phạm vi đọc/chạy được', function () {
    $errors = [];
    $agent = p10dagent($errors);
    $a = new Actors($this);
    p10enabled($a);
    $sa = $a->spa('SA');
    p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'web', 'compose_yaml' => P10YAML])
        ->assertStatus(202);
    $p = ComposeProject::query()->firstOrFail();
    $sid = $a->server->uuid;
    $routes = [['GET', "servers/$sid/docker"], ['POST', "servers/$sid/docker:enable"], ['POST', "servers/$sid/docker:sync-firewall"],
        ['GET', "servers/$sid/docker/containers"], ['GET', "servers/$sid/docker/images"], ['GET', "servers/$sid/docker/volumes"],
        ['GET', "servers/$sid/docker/networks"], ['GET', "servers/$sid/docker/port-allocations"], ['POST', "servers/$sid/docker/images:prune"],
        ['DELETE', "servers/$sid/docker/volumes/data"], ['POST', "servers/$sid/docker/containers/abcdefabcdef:restart"],
        ['GET', "servers/$sid/docker/containers/abcdefabcdef/logs"], ['GET', 'compose-projects'], ['POST', 'compose-projects'],
        ['GET', "compose-projects/{$p->uuid}"], ['PATCH', "compose-projects/{$p->uuid}"], ['DELETE', "compose-projects/{$p->uuid}"],
        ['POST', "compose-projects/{$p->uuid}:up"], ['POST', "compose-projects/{$p->uuid}:update-images"],
        ['GET', "compose-projects/{$p->uuid}/revisions"], ['POST', 'compose-projects:validate'], ['GET', 'compose-templates'],
        ['GET', 'registries'], ['POST', 'registries']];
    $n = count($agent->calls);
    foreach (['US_OWNER', 'US_OTHER'] as $who) {
        $u = $a->spa($who);
        foreach ($routes as [$m, $path]) {
            expect(p10dk($u, $m, "/api/v1/admin/$path")->status())->toBeIn([401, 403, 404, 419]); // phiên Portal không qua được realm Admin
            expect(p10dk($u, $m, "/api/v1/portal/$path")->status())->toBeIn([403, 404]);
        }
    }
    $out = $a->spa('AD_OUT');
    foreach (["servers/$sid/docker", "servers/$sid/docker/containers", "compose-projects/{$p->uuid}"] as $path) {
        expect($out->get("/api/v1/admin/$path")->status())->toBe(404);
    }
    expect($out->get('/api/v1/admin/compose-projects')->json('data'))->toBe([]);
    expect(count($agent->calls))->toBe($n);

    $in = $a->spa('AD_IN');
    $list = $in->get('/api/v1/admin/compose-projects');
    assertMatchesContract(P10D, 'get', '/api/v1/admin/compose-projects', 200, $list);
    expect($list->json('data.0.uuid'))->toBe($p->uuid);
    assertMatchesContract(P10D, 'get', '/api/v1/admin/compose-templates', 200, $in->get('/api/v1/admin/compose-templates'));
    assertMatchesContract(P10D, 'get', '/api/v1/admin/servers/{id}/docker/containers', 200, $in->get("/api/v1/admin/servers/$sid/docker/containers"));
    $down = p10dk($in, 'POST', "/api/v1/admin/compose-projects/{$p->uuid}:down");
    assertMatchesContract(P10D, 'post', '/api/v1/admin/compose-projects/{id}:down', 202, $down);
    expect($p->refresh()->run_state)->toBe('stopped');
    expect($in->get('/api/v1/admin/registries')->status())->toBe(403)->and($errors)->toBe([]);
});

it('website loại docker: vhost proxy tới cổng đã cấp; Portal không tạo được; project có website không xóa được', function () {
    $errors = [];
    $agent = p10dagent($errors);
    $a = new Actors($this);
    p10enabled($a);
    $sa = $a->spa('SA');
    p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'kuma', 'compose_yaml' => P10YAML])
        ->assertStatus(202);
    $p = ComposeProject::query()->firstOrFail();

    $u = p10dk($a->spa('US_OWNER'), 'POST', '/api/v1/portal/websites', ['hosting_account_uuid' => $a->account->uuid, 'primary_domain' => 'kuma.vn',
        'type' => 'docker', 'docker_target' => ['compose_project_uuid' => $p->uuid, 'service' => 'app']]);
    expect($u->status())->toBeIn([403, 422]);
    expect(p10dk($sa, 'POST', '/api/v1/admin/websites', ['hosting_account_uuid' => $a->account->uuid, 'primary_domain' => 'kuma.vn',
        'type' => 'docker', 'docker_target' => ['compose_project_uuid' => $p->uuid, 'service' => 'nope']])->status())->toBe(422);
    $w = p10dk($sa, 'POST', '/api/v1/admin/websites', ['hosting_account_uuid' => $a->account->uuid, 'primary_domain' => 'kuma.vn',
        'type' => 'docker', 'docker_target' => ['compose_project_uuid' => $p->uuid, 'service' => 'app']]);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/websites', 202, $w);
    $vhost = collect($agent->calls)->last(fn ($c) => $c['op'] === 'nginx.vhost.apply');
    expect($vhost['params']['type'])->toBe('proxy')->and($vhost['params']['proxy_port'])->toBe(20000);
    $site = Website::query()->where('primary_domain', 'kuma.vn')->firstOrFail();
    expect($site->type)->toBe('docker')->and($site->compose_project_id)->toBe($p->id);
    expect($sa->get("/api/v1/admin/compose-projects/{$p->uuid}")->json('data.websites.0.domain'))->toBe('kuma.vn');
    $del = p10dk($sa, 'DELETE', "/api/v1/admin/compose-projects/{$p->uuid}");
    expect($del->status())->toBe(409)->and($del->json('code'))->toBe('resource_locked');
    expect($errors)->toBe([]);
});

it('firewall scope=docker: chỉ accept/in/tcp|udp, không vào ruleset nftables; docker:sync-firewall gửi cổng mở', function () {
    $errors = [];
    $agent = p10dagent($errors);
    $a = new Actors($this);
    p10enabled($a);
    $sa = $a->spa('SA');
    $id = $a->server->uuid;

    expect($sa->post("/api/v1/admin/servers/$id/firewall/rules", ['priority' => 50, 'action' => 'drop', 'direction' => 'in', 'protocol' => 'tcp',
        'ports' => '20000', 'source' => '0.0.0.0/0', 'scope' => 'docker'])->status())->toBe(422);
    expect($sa->post("/api/v1/admin/servers/$id/firewall/rules", ['priority' => 50, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'tcp',
        'ports' => '20000-20010', 'source' => '0.0.0.0/0', 'scope' => 'docker'])->status())->toBe(422);
    $r = $sa->post("/api/v1/admin/servers/$id/firewall/rules", ['priority' => 50, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'tcp',
        'ports' => '20000,20001', 'source' => '10.0.0.0/8', 'comment' => 'Kuma nội bộ', 'scope' => 'docker']);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/servers/{id}/firewall/rules', 201, $r);
    expect($r->json('data.scope'))->toBe('docker');
    expect($sa->get("/api/v1/admin/servers/$id/firewall/preview")->json('data.ruleset'))->not->toContain('20001');

    $s = p10dk($sa, 'POST', "/api/v1/admin/servers/$id/docker:sync-firewall");
    assertMatchesContract(P10D, 'post', '/api/v1/admin/servers/{id}/docker:sync-firewall', 202, $s);
    expect(collect($agent->calls)->last()['params']['open_ports'])->toEqual([
        ['port' => 20000, 'protocol' => 'tcp', 'source' => '10.0.0.0/8'], ['port' => 20001, 'protocol' => 'tcp', 'source' => '10.0.0.0/8']]);
    expect($sa->get("/api/v1/admin/servers/$id/docker")->json('data.firewall.open_ports.0.note'))->toBe('Kuma nội bộ');
    expect(p10dk($a->spa('AD_IN'), 'POST', "/api/v1/admin/servers/$id/docker:sync-firewall")->status())->toBe(403)->and($errors)->toBe([]);
});

it('cập nhật image giữ bản rollback; quay về khi có bản; container ngoài panel không điều khiển được', function () {
    $errors = [];
    $agent = p10dagent($errors, ['docker.container.list' => fn () => ['containers' => [
        ['id' => str_repeat('a', 64), 'name' => 'itso_x-app-1', 'image' => 'nginx:1.27', 'state' => 'running', 'status' => 'Up 1 minute',
            'project_uuid' => ComposeProject::query()->value('uuid'), 'service' => 'app', 'health' => 'healthy'],
        ['id' => str_repeat('b', 64), 'name' => 'other', 'image' => 'busybox', 'state' => 'running', 'status' => 'Up', 'project_uuid' => null,
            'service' => null, 'health' => null]]],
        'docker.container.stats' => fn (array $e) => ['stats' => array_map(fn ($id) => ['id' => $id, 'cpu_pct' => 1.5, 'mem_mb' => 20.0,
            'mem_limit_mb' => 512.0, 'pids' => 3], $e['params']['ids'])],
        'docker.container.control' => fn () => ['state' => 'running']]);
    $a = new Actors($this);
    p10enabled($a);
    $sa = $a->spa('SA');
    p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'web', 'compose_yaml' => P10YAML])
        ->assertStatus(202);
    $p = ComposeProject::query()->firstOrFail();

    $rb = p10dk($sa, 'POST', "/api/v1/admin/compose-projects/{$p->uuid}:rollback-images", []);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/compose-projects/{id}:rollback-images', 409, $rb);
    $up = p10dk($sa, 'POST', "/api/v1/admin/compose-projects/{$p->uuid}:update-images", ['services' => []]);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/compose-projects/{id}:update-images', 202, $up);
    expect(collect($agent->calls)->last()['params'])->toMatchArray(['services' => ['app'], 'health_timeout_sec' => 60, 'keep_rollbacks' => 2]);
    expect(ImageRollback::query()->where('compose_project_id', $p->id)->value('state'))->toBe('succeeded');
    expect(p10dk($sa, 'POST', "/api/v1/admin/compose-projects/{$p->uuid}:update-images", ['services' => ['ghost']])->status())->toBe(422);
    p10dk($sa, 'POST', "/api/v1/admin/compose-projects/{$p->uuid}:rollback-images", ['services' => ['app']])->assertStatus(202);
    expect(ImageRollback::query()->where('compose_project_id', $p->id)->value('state'))->toBe('rolled_back');
    expect($sa->get("/api/v1/admin/compose-projects/{$p->uuid}")->json('data.last_image_update.state'))->toBe('rolled_back');

    $c = $sa->get("/api/v1/admin/servers/{$a->server->uuid}/docker/containers");
    assertMatchesContract(P10D, 'get', '/api/v1/admin/servers/{id}/docker/containers', 200, $c);
    $app = collect($c->json('data'))->firstWhere('name', 'itso_x-app-1');
    expect($app['compose_project'])->toBe('web')->and($app['ports'])->toBe(['127.0.0.1:20000->80/tcp'])->and($app['cpu_pct'])->toBe(1.5);
    $ctl = p10dk($sa, 'POST', "/api/v1/admin/servers/{$a->server->uuid}/docker/containers/".str_repeat('a', 12).':restart');
    assertMatchesContract(P10D, 'post', '/api/v1/admin/servers/{id}/docker/containers/{container}:{action}', 202, $ctl);
    expect(collect($agent->calls)->last()['params'])->toBe(['id' => str_repeat('a', 64), 'action' => 'restart']);
    expect(p10dk($sa, 'POST', "/api/v1/admin/servers/{$a->server->uuid}/docker/containers/".str_repeat('b', 12).':stop')->status())->toBe(404);
    expect(AuditLog::query()->where('action', 'docker.container_restart')->exists())->toBeTrue()->and($errors)->toBe([]);
});

it('backup policy phạm vi compose_project → docker.volume.backup vào repo server; khôi phục volume ra volume mới', function () {
    $errors = [];
    $agent = p10dagent($errors);
    $a = new Actors($this);
    p10enabled($a);
    $sa = $a->spa('SA');
    p10dk($sa, 'POST', '/api/v1/admin/compose-projects', ['server_uuid' => $a->server->uuid, 'name' => 'web', 'compose_yaml' => P10YAML])
        ->assertStatus(202);
    $p = ComposeProject::query()->firstOrFail();
    $d = $sa->post('/api/v1/admin/backup-destinations', ['name' => 'Local', 'type' => 'local', 'config' => ['path' => '/var/backups/itso']]);
    $dest = BackupDestination::query()->where('uuid', $d->json('data.uuid'))->firstOrFail();

    expect($sa->post('/api/v1/admin/backup-policies', ['name' => 'Sai', 'scope_type' => 'compose_project', 'scope_uuid' => $p->uuid,
        'contents' => ['files'], 'schedule' => '0 3 * * *', 'destination_uuids' => [$dest->uuid]])->status())->toBe(422);
    $pol = $sa->post('/api/v1/admin/backup-policies', ['name' => 'Volume web', 'scope_type' => 'compose_project', 'scope_uuid' => $p->uuid,
        'contents' => ['docker_volumes'], 'volume_consistency' => 'pause', 'schedule' => '0 3 * * *', 'destination_uuids' => [$dest->uuid]]);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/backup-policies', 201, $pol);
    $n = count($agent->calls);
    p10dk($sa, 'POST', '/api/v1/admin/backup-policies/'.$pol->json('data.uuid').':run')->assertStatus(202);
    expect(array_slice($agent->ops(), $n))->toBe(['backup.repo.init', 'docker.volume.backup', 'backup.stats']);
    $vb = collect($agent->calls)->firstWhere('op', 'docker.volume.backup')['params'];
    expect($vb['volumes'])->toBe(["itso_{$p->uuid}_data"])->and($vb['tags'])->toContain('compose:'.$p->uuid, 'type:docker');
    $snap = BackupSnapshot::query()->firstOrFail();
    expect($snap->scope_type)->toBe('compose_project')->and($snap->scope_id)->toBe($p->id)->and($snap->contents)->toBe(['docker_volumes']);

    expect(p10dk($sa, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $snap->uuid, 'mode' => 'new', 'items' => ['volume:khac']])->status())->toBe(422);
    expect(p10dk($sa, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $snap->uuid, 'mode' => 'overwrite',
        'items' => ["volume:itso_{$p->uuid}_data"], 'confirm' => 'sai'])->status())->toBe(422);
    $r = p10dk($sa, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $snap->uuid, 'mode' => 'new', 'items' => ["volume:itso_{$p->uuid}_data"]]);
    assertMatchesContract(P10D, 'post', '/api/v1/admin/restores', 202, $r);
    $rp = collect($agent->calls)->last()['params'];
    expect($rp['volume'])->toBe("itso_{$p->uuid}_data")->and($rp['target'])->toStartWith("itso_{$p->uuid}_data_r")->and($rp['mode'])->toBe('new');
    expect(DB::table('restore_jobs')->value('status'))->toBe('succeeded')->and(Job::query()->where('type', 'backup.restore')->value('state'))->toBe('succeeded');
    expect($errors)->toBe([]);
});
