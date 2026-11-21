<?php

use App\Models\TerminalRecording;
use App\Models\TerminalSession;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 7.5 (ADR 0028): terminal root theo policy cục bộ, ghi phiên, pty.list, API bản ghi, itso:allowlist-reset.

require_once __DIR__.'/helpers.php';

function p7term(array $over = []): FakeAgent
{
    return new FakeAgent($over + [
        'pty.open.root' => fn () => ['ticket' => str_repeat('R', 43), 'expires_at' => now()->addSeconds(30)->utc()->toIso8601String(),
            'unix_user' => 'root', 'recording' => true],
        'pty.policy' => fn () => ['root_enabled' => true, 'record_root' => true, 'record_user' => false, 'max_sessions_per_account' => 2,
            'idle_timeout_sec' => 900],
        'pty.list' => fn () => ['sessions' => []],
        '*' => fn () => ['ok' => true],
    ]);
}

it('SUPER_ADMIN mở terminal root (đã step-up): ticket một lần, ghi terminal_sessions + terminal_recordings, khớp hợp đồng', function () {
    $agent = p7term();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $r = $sa->post('/api/v1/admin/terminal/sessions', ['mode' => 'root', 'server_uuid' => $a->server->uuid]);
    assertMatchesContract(P7A, 'post', '/api/v1/admin/terminal/sessions', 201, $r);
    expect($r->json('data'))->toMatchArray(['mode' => 'root', 'unix_user' => 'root', 'ticket' => str_repeat('R', 43)])
        ->and($agent->ops())->toBe(['pty.open.root'])
        ->and($agent->calls[0]['params'])->toEqual(['session_uuid' => $r->json('data.session_uuid'), 'cols' => 120, 'rows' => 32, 'idle_timeout_sec' => 900]);
    $s = TerminalSession::query()->where('uuid', $r->json('data.session_uuid'))->firstOrFail();
    expect($s)->mode->toBe('root')->unix_uid->toBe(0)->hosting_account_id->toBeNull()->recording_ref->toBe($s->uuid.'.cast');
    $rec = TerminalRecording::query()->findOrFail($s->id);
    expect($rec)->mode->toBe('root')->stored_ref->toBe($s->uuid.'.cast')->truncated->toBeFalse();
    expect(DB::table('audit_logs')->where('action', 'terminal.open')->where('result', 'success')->count())->toBe(1);
    foreach (['audit_logs', 'terminal_sessions', 'terminal_recordings'] as $t) {
        expect(DB::table($t)->get()->contains(fn ($row) => str_contains(json_encode($row), str_repeat('R', 43))))->toBeFalse("ticket lộ trong $t");
    }
});

it('root bị từ chối khi policy máy chủ tắt dù panel yêu cầu; ADMIN thường, USER, thiếu server, step-up quá 10 phút đều bị chặn', function () {
    $agent = p7term(['pty.open.root' => fn () => ['__error' => ['op_disabled', 'terminal root đang tắt trong policy cục bộ', false]]]);
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $root = fn ($spa, array $b = []) => $spa->post('/api/v1/admin/terminal/sessions', $b + ['mode' => 'root', 'server_uuid' => $a->server->uuid]);

    $off = $root($sa);
    assertMatchesContract(P7A, 'post', '/api/v1/admin/terminal/sessions', 409, $off);
    expect($off->json('code'))->toBe('precondition_failed')->and($off->json('detail'))->toContain('itso policy set terminal.root on')
        ->and(TerminalSession::query()->latest('id')->first())->ended_reason->toBe('error')
        ->and(TerminalRecording::query()->count())->toBe(0)
        ->and(DB::table('audit_logs')->where('action', 'terminal.open')->where('result', 'failure')->count())->toBe(1);

    // ADMIN (kể cả trong phạm vi server, đã step-up) không mở được root; agent không được gọi.
    $calls = count($agent->calls);
    $ad = $root($a->spa('AD_IN'));
    assertMatchesContract(P7A, 'post', '/api/v1/admin/terminal/sessions', 403, $ad);
    expect($ad->json('code'))->toBe('forbidden')->and(count($agent->calls))->toBe($calls);
    // USER ở Portal.
    $owner = $a->spa('US_OWNER');
    Actors::enrollAndStepUp($this, $owner);
    $pu = $owner->post('/api/v1/portal/terminal/sessions', ['mode' => 'root', 'server_uuid' => $a->server->uuid]);
    expect($pu->status())->toBe(403)->and(count($agent->calls))->toBe($calls);
    // Thiếu/sai server.
    expect($root($sa, ['server_uuid' => null])->status())->toBe(422)
        ->and($root($sa, ['server_uuid' => '01938a25-0000-7000-8000-00000000dead'])->status())->toBe(422);

    // step_up_seconds cấu hình 1 giờ nhưng root vẫn đòi step-up trong 10 phút; terminal account thì vẫn theo cấu hình.
    config(['itso.auth.step_up_seconds' => 3600]);
    $this->travel(11)->minutes();
    $stale = $root($sa);
    expect($stale->status())->toBe(403)->and($stale->json('code'))->toBe('mfa_step_up_required')->and(count($agent->calls))->toBe($calls);
});

it('ticket root dùng lại bị agent từ chối: panel cấp phiên mới cho mỗi lần mở (session_uuid khác nhau)', function () {
    $agent = p7term();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $u1 = $sa->post('/api/v1/admin/terminal/sessions', ['mode' => 'root', 'server_uuid' => $a->server->uuid])->json('data.session_uuid');
    $u2 = $sa->post('/api/v1/admin/terminal/sessions', ['mode' => 'root', 'server_uuid' => $a->server->uuid])->json('data.session_uuid');
    expect($u1)->not->toBe($u2)
        ->and(array_column(array_column($agent->calls, 'params'), 'session_uuid'))->toBe([$u1, $u2]);
    // Agent hết chỗ (2 phiên root) → 409 resource_locked.
    $agent->on('pty.open.root', fn () => ['__error' => ['quota_exceeded', 'tối đa 2 phiên', false]]);
    expect($sa->post('/api/v1/admin/terminal/sessions', ['mode' => 'root', 'server_uuid' => $a->server->uuid])->json('code'))->toBe('resource_locked');
});

it('policy terminal đọc từ agent; danh sách phiên theo phạm vi (ADMIN không thấy phiên root)', function () {
    $agent = p7term();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $pol = $sa->get('/api/v1/admin/servers/'.$a->server->uuid.'/terminal/policy');
    assertMatchesContract(P7A, 'get', '/api/v1/admin/servers/{id}/terminal/policy', 200, $pol);
    expect($pol->json('data'))->toMatchArray(['root_enabled' => true, 'record_root' => true, 'record_user' => false])
        ->and($pol->json('data.server.uuid'))->toBe($a->server->uuid);

    $rootUuid = $sa->post('/api/v1/admin/terminal/sessions', ['mode' => 'root', 'server_uuid' => $a->server->uuid])->json('data.session_uuid');
    $acc = TerminalSession::query()->create(['user_id' => $a->adminIn->id, 'server_id' => $a->server->id, 'hosting_account_id' => $a->account->id,
        'unix_uid' => $a->account->uid, 'mode' => 'account', 'started_at' => now()->subMinutes(5), 'ended_at' => now(), 'ended_reason' => 'error']);
    $list = $sa->get('/api/v1/admin/terminal/sessions');
    assertMatchesContract(P7A, 'get', '/api/v1/admin/terminal/sessions', 200, $list);
    expect(collect($list->json('data'))->pluck('uuid')->all())->toBe([$rootUuid, $acc->uuid]);
    $first = $list->json('data.0');
    expect($first)->toMatchArray(['mode' => 'root', 'unix_user' => 'root', 'hosting_account' => null, 'recorded' => true, 'client_ip' => '127.0.0.1'])
        ->and($list->json('data.1.ended_reason'))->toBe('killed');

    $ad = $a->spa('AD_IN')->get('/api/v1/admin/terminal/sessions');
    expect(collect($ad->json('data'))->pluck('uuid')->all())->toBe([$acc->uuid]);
    expect($a->spa('AD_OUT')->get('/api/v1/admin/terminal/sessions')->json('data'))->toBe([]);
    expect($a->spa('AD_OUT')->get('/api/v1/admin/servers/'.$a->server->uuid.'/terminal/policy')->status())->toBe(404);
});

it('bản ghi đọc theo offset: trang nối tiếp, next_offset null khi hết; chỉ SUPER_ADMIN + step-up; metadata cập nhật', function () {
    $pages = [
        0 => ['width' => 120, 'height' => 32, 'events' => [['t' => 0.0, 'data' => 'root@srv:~# '], ['t' => 1.25, 'data' => "whoami\r\n"]],
            'next_offset' => 180, 'truncated' => false, 'eof' => false],
        180 => ['width' => 120, 'height' => 32, 'events' => [['t' => 1.3, 'data' => "root\r\n"]], 'next_offset' => 240, 'truncated' => true, 'eof' => true],
    ];
    $agent = p7term(['pty.recording.read' => fn (array $env) => $pages[$env['params']['offset']] ?? ['__error' => ['invalid_params', 'offset không nằm ở đầu dòng', false]]]);
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $id = $sa->post('/api/v1/admin/terminal/sessions', ['mode' => 'root', 'server_uuid' => $a->server->uuid])->json('data.session_uuid');
    $url = "/api/v1/admin/terminal/sessions/$id/recording";

    $p1 = $sa->get($url);
    assertMatchesContract(P7A, 'get', '/api/v1/admin/terminal/sessions/{id}/recording', 200, $p1);
    expect($p1->json('data'))->toMatchArray(['session_uuid' => $id, 'width' => 120, 'height' => 32, 'next_offset' => 180, 'truncated' => false])
        ->and($p1->json('data.events.1.data'))->toBe("whoami\r\n")
        ->and(end($agent->calls)['params'])->toEqual(['session_uuid' => $id, 'offset' => 0, 'max_bytes' => 262144]);
    $p2 = $sa->get("$url?offset=180");
    expect($p2->json('data'))->toMatchArray(['next_offset' => null, 'truncated' => true])
        ->and(end($agent->calls)['params']['offset'])->toBe(180);
    $rec = TerminalRecording::query()->where('stored_ref', "$id.cast")->firstOrFail();
    expect($rec)->bytes->toBe(240)->truncated->toBeTrue();
    expect(DB::table('audit_logs')->where('action', 'terminal.recording_view')->count())->toBe(1); // một lần mỗi lượt xem

    expect($sa->get("$url?offset=7")->status())->toBe(422)
        ->and($sa->get("$url?offset=-1")->status())->toBe(422)
        ->and($sa->get("$url?offset=abc")->status())->toBe(422);
    // ADMIN không xem được bản ghi; step-up quá hạn → 403.
    expect($a->spa('AD_IN')->get($url)->status())->toBe(403);
    $this->travel(11)->minutes();
    expect($sa->get($url)->json('code'))->toBe('mfa_step_up_required');
    // Phiên không có bản ghi → 404.
    $sa = $a->spa('SA');
    $plain = TerminalSession::query()->create(['user_id' => $a->sa->id, 'server_id' => $a->server->id, 'hosting_account_id' => $a->account->id,
        'unix_uid' => $a->account->uid, 'mode' => 'account', 'started_at' => now()]);
    expect($sa->get("/api/v1/admin/terminal/sessions/{$plain->uuid}/recording")->status())->toBe(404);
});

it('itso:terminal-reap dùng pty.list: đóng phiên agent không còn giữ, giữ phiên còn sống và phiên mới cấp; ghi metadata phiên account được ghi', function () {
    $a = new Actors($this);
    $mk = fn (int $sec, string $mode = 'account') => TerminalSession::query()->create(['user_id' => $a->sa->id, 'server_id' => $a->server->id,
        'hosting_account_id' => $mode === 'root' ? null : $a->account->id, 'unix_uid' => $mode === 'root' ? 0 : $a->account->uid, 'mode' => $mode,
        'started_at' => now()->subSeconds($sec)]);
    $gone = $mk(600);
    $alive = $mk(3 * 3600);
    $fresh = $mk(10);
    $agent = p7term(['pty.list' => fn () => ['sessions' => [
        ['session_uuid' => $alive->uuid, 'mode' => 'account', 'unix_user' => $a->account->username, 'started_at' => '2026-11-21T01:00:00Z',
            'last_input_at' => '2026-11-21T03:59:00Z', 'recording' => true, 'recording_bytes' => 4096],
    ]]]);
    $this->artisan('itso:terminal-reap')->assertSuccessful();
    expect($gone->refresh())->ended_reason->toBe('closed')->ended_at->not->toBeNull()
        ->and($alive->refresh())->ended_at->toBeNull()->recording_ref->toBe($alive->uuid.'.cast')
        ->and($fresh->refresh()->ended_at)->toBeNull()
        ->and(TerminalRecording::query()->findOrFail($alive->id))->bytes->toBe(4096)->mode->toBe('account')
        ->and($agent->ops())->toBe(['pty.list']);

    // Agent không trả lời → luật 12 giờ.
    $agent->on('pty.list', fn () => ['__error' => ['internal', 'lỗi', true]]);
    $old = $mk(13 * 3600);
    $this->artisan('itso:terminal-reap')->assertSuccessful();
    expect($old->refresh()->ended_reason)->toBe('expired')->and($alive->refresh()->ended_at)->toBeNull();
});

it('itso:allowlist-reset xóa IP allowlist Admin và ghi audit (cứu hộ khi tự khóa)', function () {
    DB::table('ip_allowlist')->insert([['cidr' => '10.10.0.0/16', 'scope' => 'admin', 'note' => 'VPN'], ['cidr' => '192.0.2.0/24', 'scope' => 'api', 'note' => null]]);
    $this->artisan('itso:allowlist-reset')->expectsOutputToContain('Đã xóa 1 mục')->assertSuccessful();
    expect(DB::table('ip_allowlist')->where('scope', 'admin')->count())->toBe(0)
        ->and(DB::table('ip_allowlist')->where('scope', 'api')->count())->toBe(1)
        ->and(DB::table('audit_logs')->where('action', 'security.ip_allowlist_reset')->count())->toBe(1);
    $this->artisan('itso:allowlist-reset')->expectsOutputToContain('đang trống')->assertSuccessful();
});
