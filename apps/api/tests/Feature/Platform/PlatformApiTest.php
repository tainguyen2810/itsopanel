<?php

use App\Domain\Audit\AuditChain;
use App\Domain\Audit\AuditLogger;
use App\Domain\Notifications\Notifier;
use App\Domain\Servers\ServerFacts;
use App\Http\Controllers\Api\V1\Admin\AuditLogController;
use App\Http\Controllers\Api\V1\Admin\SettingsController;
use App\Models\Agent;
use App\Models\AuditLog;
use App\Models\Server;
use App\Models\Setting;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

const XA = 'itso-admin-v1.yaml';
const XP = 'itso-portal-v1.yaml';

it('audit log: append-only (UPDATE/DELETE bị DB chặn), chuỗi hash hợp lệ; sửa trực tiếp bị phát hiện', function () {
    $a = new Actors($this);
    $logger = app(AuditLogger::class);
    foreach (range(1, 5) as $i) {
        $logger->record("test.action$i", $a->account, ['i' => $i, 'password' => 'bí mật'], 'success', null, null, $a->sa);
    }
    expect(AuditChain::verify())->toMatchArray(['broken_id' => null])
        ->and(AuditLog::query()->where('action', 'test.action1')->value('changes'))->toBe(['i' => 1, 'password' => '[REDACTED]']);
    expect(fn () => DB::transaction(fn () => DB::update("UPDATE audit_logs SET action = 'x'")))->toThrow(Exception::class);
    expect(fn () => DB::transaction(fn () => DB::delete('DELETE FROM audit_logs')))->toThrow(Exception::class);

    // Giả lập kẻ có quyền DB bỏ trigger rồi sửa: kiểm chuỗi phát hiện.
    DB::statement('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    DB::update("UPDATE audit_logs SET action = 'sua.len' WHERE action = 'test.action3'");
    DB::statement('ALTER TABLE audit_logs ENABLE TRIGGER USER');
    expect(AuditChain::verify()['broken_id'])->toBe((int) AuditLog::query()->where('action', 'sua.len')->value('id'));
    $this->artisan('itso:audit-verify')->assertFailed();
});

it('audit-logs API: lọc, phạm vi ADMIN, xuất CSV chống chèn công thức', function () {
    $a = new Actors($this);
    $logger = app(AuditLogger::class);
    $logger->record('=HYPERLINK("http://x")', $a->account, null, 'success', $a->server->id, null, $a->owner);
    $logger->record('server.update', null, null, 'success', null, null, $a->sa);
    $sa = $a->spa('SA');
    $all = $sa->get('/api/v1/admin/audit-logs', ['filter[action]' => 'server.*']);
    assertMatchesContract(XA, 'get', '/api/v1/admin/audit-logs', 200, $all);
    expect(collect($all->json('data'))->pluck('action')->unique()->values()->all())->toBe(['server.update']);

    $in = collect($a->spa('AD_IN')->get('/api/v1/admin/audit-logs', ['limit' => 200])->json('data'))->pluck('action');
    $out = collect($a->spa('AD_OUT')->get('/api/v1/admin/audit-logs', ['limit' => 200])->json('data'))->pluck('action');
    expect($in)->toContain('=HYPERLINK("http://x")')->not->toContain('server.update')
        ->and($out)->not->toContain('=HYPERLINK("http://x")', 'server.update');

    $csv = $sa->get('/api/v1/admin/audit-logs/export');
    expect($csv->getStatusCode())->toBe(200)->and($csv->headers->get('Content-Type'))->toStartWith('text/csv');
    $body = $csv->streamedContent();
    expect($body)->toContain("'=HYPERLINK")->not->toMatch('/,=HYPERLINK/')
        ->and(AuditLogController::csvCell('+1'))->toBe("'+1")->and(AuditLogController::csvCell('-x'))->toBe("'-x")
        ->and(AuditLogController::csvCell('@a'))->toBe("'@a")->and(AuditLogController::csvCell('ok'))->toBe('ok');
    expect($a->spa('AD_IN')->get('/api/v1/admin/audit-logs/export')->getStatusCode())->toBe(403);
});

it('thao tác ghi bị từ chối 403 được ghi audit result=denied', function () {
    $a = new Actors($this);
    $a->spa('AD_IN')->get('/api/v1/admin/settings/general')->assertStatus(403);
    $a->spa('AD_IN')->call('PATCH', '/api/v1/admin/settings/general', ['panel_name' => 'X'])->assertStatus(403);
    $denied = AuditLog::query()->where('result', 'denied')->where('actor_user_id', $a->adminIn->id)->get();
    expect($denied)->toHaveCount(1)
        ->and($denied[0]->action)->toBe('access.denied')
        ->and($denied[0]->changes)->toMatchArray(['method' => 'PATCH', 'path' => '/api/v1/admin/settings/general']);
});

it('thông báo: chỉ của chính user; đọc một / đọc hết; admin và portal khớp hợp đồng', function () {
    $a = new Actors($this);
    $n = app(Notifier::class);
    $mine = $n->notify($a->owner, 'job.failed', 'Tác vụ thất bại', 'chi tiết', 'high', '/portal/jobs/x');
    $n->notify($a->owner, 'info', 'Thứ hai');
    $theirs = $n->notify($a->otherUser, 'info', 'Của người khác');
    $n->notify($a->sa, 'info', 'Cho SA');

    $po = $a->spa('US_OWNER');
    $list = $po->get('/api/v1/portal/notifications');
    assertMatchesContract(XP, 'get', '/api/v1/portal/notifications', 200, $list);
    expect(collect($list->json('data'))->pluck('title')->sort()->values()->all())->toBe(['Thứ hai', 'Tác vụ thất bại']);
    $uuid = collect($list->json('data'))->firstWhere('title', 'Tác vụ thất bại')['uuid'];
    expect(collect($list->json('data'))->firstWhere('title', 'Tác vụ thất bại'))->toMatchArray(['severity' => 'high', 'read_at' => null]);
    assertMatchesContract(XP, 'post', '/api/v1/portal/notifications/{id}:read', 204, $po->post("/api/v1/portal/notifications/$uuid:read"));
    expect($mine->refresh()->read_at)->not->toBeNull();

    $theirUuid = collect($a->spa('US_OTHER')->get('/api/v1/portal/notifications')->json('data'))->first()['uuid'];
    assertMatchesContract(XP, 'post', '/api/v1/portal/notifications/{id}:read', 404, $po->post("/api/v1/portal/notifications/$theirUuid:read"));
    assertMatchesContract(XP, 'post', '/api/v1/portal/notifications:read-all', 204, $po->post('/api/v1/portal/notifications:read-all'));
    expect($theirs->refresh()->read_at)->toBeNull();

    $sa = $a->spa('SA');
    $sl = $sa->get('/api/v1/admin/notifications');
    assertMatchesContract(XA, 'get', '/api/v1/admin/notifications', 200, $sl);
    expect(collect($sl->json('data'))->pluck('title')->all())->toBe(['Cho SA']);
});

it('cài đặt: chỉ SA, không trả secret, ETag/If-Match 412, khóa lạ 422, PATCH cần step-up', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $g = $sa->get('/api/v1/admin/settings/smtp');
    assertMatchesContract(XA, 'get', '/api/v1/admin/settings/{group}', 200, $g);
    expect($g->json('data.values'))->toMatchArray(['port' => 587, 'password_set' => false])->not->toHaveKey('password');
    $etag = $g->headers->get('ETag');

    $p = $sa->call('PATCH', '/api/v1/admin/settings/smtp', ['host' => 'smtp.itso.local', 'password' => 'S3cret!pass'], ['If-Match' => $etag]);
    assertMatchesContract(XA, 'patch', '/api/v1/admin/settings/{group}', 200, $p);
    expect($p->json('data.values'))->toMatchArray(['host' => 'smtp.itso.local', 'password_set' => true])
        ->and($p->getContent())->not->toContain('S3cret')
        ->and(json_encode(Setting::query()->where('key', 'password')->value('value')))->not->toContain('S3cret')
        ->and(SettingsController::secret('smtp', 'password'))->toBe('S3cret!pass')
        ->and(json_encode(AuditLog::query()->where('action', 'settings.smtp.update')->value('changes')))->not->toContain('S3cret');

    expect($sa->call('PATCH', '/api/v1/admin/settings/smtp', ['port' => 25], ['If-Match' => $etag])->status())->toBe(412);
    assertMatchesContract(XA, 'patch', '/api/v1/admin/settings/{group}', 422, $sa->call('PATCH', '/api/v1/admin/settings/smtp', ['khong_co' => 1]));
    assertMatchesContract(XA, 'patch', '/api/v1/admin/settings/{group}', 422, $sa->call('PATCH', '/api/v1/admin/settings/smtp', ['port' => 70000]));
    expect($sa->call('PATCH', '/api/v1/admin/settings/security', ['admin_mfa_required' => false])->status())->toBe(422);
    assertMatchesContract(XA, 'get', '/api/v1/admin/settings/{group}', 404, $sa->get('/api/v1/admin/settings/khac'));
    assertMatchesContract(XA, 'get', '/api/v1/admin/settings/{group}', 403, $a->spa('AD_IN')->get('/api/v1/admin/settings/general'));

    $this->travel(11)->minutes();
    $r = $sa->call('PATCH', '/api/v1/admin/settings/general', ['panel_name' => 'Panel']);
    expect($r->status())->toBe(403)->and($r->json('code'))->toBe('mfa_step_up_required');
});

it('servers: server local từ cấu hình + làm mới dữ kiện từ agent; đọc/sửa theo phạm vi, ETag', function () {
    config(['itso.local_server' => ['enabled' => true, 'name' => 'srv-local', 'hostname' => 'panel.local', 'role_tags' => ['web', 'db']]]);
    new FakeAgent([
        'system.ping' => fn () => ['pong' => true, 'agent_version' => '0.1.0-mock', 'mode' => 'mock'],
        'system.info' => fn () => ['os' => 'Ubuntu 24.04.1 LTS', 'kernel' => '6.8.0', 'hostname' => 'panel', 'uptime_sec' => 3600,
            'cpu_cores' => 4, 'ram_mb' => 8192],
    ]);
    $this->artisan('itso:server-local')->assertSuccessful();
    $local = Server::query()->where('name', 'srv-local')->firstOrFail();
    expect($local)->status->toBe('ready')->os->toBe('Ubuntu 24.04.1 LTS')
        ->and(Agent::query()->where('server_id', $local->id)->value('version'))->toBe('0.1.0-mock');
    $this->artisan('itso:server-local')->assertSuccessful();
    expect(Server::query()->where('name', 'srv-local')->count())->toBe(1);

    $a = new Actors($this);
    $sa = $a->spa('SA');
    $list = $sa->get('/api/v1/admin/servers');
    assertMatchesContract(XA, 'get', '/api/v1/admin/servers', 200, $list);
    expect(collect($list->json('data'))->pluck('name'))->toContain('srv-local', $a->server->name);
    $show = $sa->get("/api/v1/admin/servers/{$local->uuid}");
    assertMatchesContract(XA, 'get', '/api/v1/admin/servers/{id}', 200, $show);
    expect($show->json('data'))->toMatchArray(['agent_connected' => true, 'agent_version' => '0.1.0-mock', 'status' => 'ready'])
        ->and($show->json('data.resources'))->toMatchArray(['cpu_cores' => 4, 'ram_mb' => 8192, 'uptime_sec' => 3600]);

    $etag = $show->headers->get('ETag');
    $p = $sa->call('PATCH', "/api/v1/admin/servers/{$local->uuid}", ['accepting_new_accounts' => false], ['If-Match' => $etag]);
    assertMatchesContract(XA, 'patch', '/api/v1/admin/servers/{id}', 200, $p);
    expect($p->json('data'))->toMatchArray(['accepting_new_accounts' => false, 'spec_version' => 2])
        ->and(AuditLog::query()->where('action', 'server.update')->exists())->toBeTrue();
    expect($sa->call('PATCH', "/api/v1/admin/servers/{$local->uuid}", ['accepting_new_accounts' => true], ['If-Match' => $etag])->status())->toBe(412);
    assertMatchesContract(XA, 'patch', '/api/v1/admin/servers/{id}', 422, $sa->call('PATCH', "/api/v1/admin/servers/{$local->uuid}", ['role_tags' => ['mail']]));
    assertMatchesContract(XA, 'patch', '/api/v1/admin/servers/{id}', 409, $sa->call('PATCH', "/api/v1/admin/servers/{$local->uuid}", ['name' => $a->server->name]));

    $in = $a->spa('AD_IN');
    expect(collect($in->get('/api/v1/admin/servers')->json('data'))->pluck('uuid')->all())->toBe([$a->server->uuid]);
    assertMatchesContract(XA, 'get', '/api/v1/admin/servers/{id}', 404, $in->get("/api/v1/admin/servers/{$local->uuid}"));
    expect($in->call('PATCH', "/api/v1/admin/servers/{$a->server->uuid}", ['accepting_new_accounts' => false])->status())->toBe(403);

    $this->travel(10)->minutes();
    expect($sa->get("/api/v1/admin/servers/{$local->uuid}")->json('data.agent_connected'))->toBeFalse();
});

it('agent không trả lời khi làm mới → server degraded', function () {
    config(['itso.local_server.enabled' => true]);
    $facts = app(ServerFacts::class);
    $s = $facts->ensureLocal();
    $s->forceFill(['status' => 'ready'])->save();
    expect($facts->refresh($s))->toBeFalse()->and($s->refresh()->status)->toBe('degraded');
});

it('dashboard summary theo phạm vi, khớp hợp đồng', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA')->get('/api/v1/admin/dashboard/summary');
    assertMatchesContract(XA, 'get', '/api/v1/admin/dashboard/summary', 200, $sa);
    expect($sa->json('data.counts'))->toMatchArray(['servers' => 2, 'hosting_accounts' => 2])
        ->and($sa->json('data.alerts_firing'))->toBe(0);
    $in = $a->spa('AD_IN')->get('/api/v1/admin/dashboard/summary');
    expect($in->json('data.counts'))->toMatchArray(['servers' => 1, 'hosting_accounts' => 1])
        ->and(collect($in->json('data.servers'))->pluck('server.uuid')->all())->toBe([$a->server->uuid])
        ->and(array_sum(array_column($in->json('data.package_distribution'), 'accounts')))->toBe(1);
});
