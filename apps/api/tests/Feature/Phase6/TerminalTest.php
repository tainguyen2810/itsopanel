<?php

use App\Models\HostingPackageVersion;
use App\Models\TerminalSession;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 6.4: POST /terminal/sessions (admin + portal) — step-up, gói có SSH, account active, ticket không lộ.

const T6A = 'itso-admin-v1.yaml';
const T6P = 'itso-portal-v1.yaml';

function t6agent(array $over = []): FakeAgent
{
    return new FakeAgent($over + [
        'pty.open' => fn (array $env) => ['ticket' => str_repeat('T', 43), 'expires_at' => now()->addSeconds(30)->utc()->toIso8601String(),
            'unix_user' => $env['params']['account']['username']],
        '*' => fn () => ['ok' => true],
    ]);
}

function t6ssh(Actors $a): void
{
    // Phiên bản gói là append-only: tạo phiên bản mới có SSH rồi chuyển account sang.
    $cur = HostingPackageVersion::query()->findOrFail($a->account->package_version_id);
    $v = HostingPackageVersion::factory()->create(['package_id' => $cur->package_id, 'version' => $cur->version + 1, 'ssh_allowed' => true]);
    $a->account->forceFill(['package_version_id' => $v->id])->save();
}

it('mở terminal: admin trong phạm vi + chủ account (đã step-up) nhận ticket; khớp hợp đồng; ticket không ghi vào DB/audit', function () {
    $agent = t6agent();
    $a = new Actors($this);
    t6ssh($a);
    $in = $a->spa('AD_IN');

    $r = $in->post('/api/v1/admin/terminal/sessions', ['hosting_account_uuid' => $a->account->uuid, 'mode' => 'account']);
    assertMatchesContract(T6A, 'post', '/api/v1/admin/terminal/sessions', 201, $r);
    expect($r->json('data'))->toMatchArray(['ticket' => str_repeat('T', 43), 'mode' => 'account', 'unix_user' => $a->account->username,
    ])
        ->and($r->json('data.ws_url'))->toEndWith('/gateway/terminal')->toStartWith('ws://')
        ->and($r->headers->get('Cache-Control'))->toContain('no-store')
        ->and($agent->ops())->toBe(['pty.open'])
        ->and($agent->calls[0]['params'])->toMatchArray(['session_uuid' => $r->json('data.session_uuid'), 'cols' => 120, 'rows' => 32, 'idle_timeout_sec' => 900]);
    $s = TerminalSession::query()->where('uuid', $r->json('data.session_uuid'))->firstOrFail();
    expect($s)->user_id->toBe($a->adminIn->id)->unix_uid->toBe($a->account->uid)->mode->toBe('account')->ended_at->toBeNull();
    expect(DB::table('audit_logs')->where('action', 'terminal.open')->count())->toBe(1);
    foreach (['audit_logs', 'terminal_sessions', 'job_steps', 'job_logs'] as $t) {
        expect(DB::table($t)->get()->contains(fn ($row) => str_contains(json_encode($row), str_repeat('T', 43))))->toBeFalse("ticket lộ trong $t");
    }

    config(['itso.gateway.ws_url' => 'wss://panel.itso.local/gateway/terminal']);
    $owner = $a->spa('US_OWNER');
    // Chủ account chưa bật MFA → 403 mfa_required; bật + step-up → 201.
    $no = $owner->post('/api/v1/portal/terminal/sessions', ['hosting_account_uuid' => $a->account->uuid, 'mode' => 'account']);
    assertMatchesContract(T6P, 'post', '/api/v1/portal/terminal/sessions', 403, $no);
    Actors::enrollAndStepUp($this, $owner);
    $p = $owner->post('/api/v1/portal/terminal/sessions', ['hosting_account_uuid' => $a->account->uuid, 'mode' => 'account']);
    assertMatchesContract(T6P, 'post', '/api/v1/portal/terminal/sessions', 201, $p);
    expect($p->json('data.ws_url'))->toBe('wss://panel.itso.local/gateway/terminal');
});

it('từ chối: gói không SSH 409, account khóa 409, mode=root 409, ngoài phạm vi 422, chưa step-up 403, agent hết chỗ 409, agent không kết nối 503', function () {
    $agent = t6agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $open = fn ($spa, array $b = []) => $spa->post('/api/v1/admin/terminal/sessions', $b + ['hosting_account_uuid' => $a->account->uuid, 'mode' => 'account']);

    $nossh = $open($sa);
    assertMatchesContract(T6A, 'post', '/api/v1/admin/terminal/sessions', 409, $nossh);
    expect($nossh->json('code'))->toBe('package_limit_reached')->and($agent->ops())->toBe([]);
    t6ssh($a);
    expect($open($sa, ['mode' => 'root'])->status())->toBe(409)
        ->and($open($sa, ['hosting_account_uuid' => null])->status())->toBe(422)
        ->and($open($sa, ['rogue' => 1])->status())->toBe(422);
    $out = $open($a->spa('AD_OUT'));
    expect($out->status())->toBe(422)->and($out->json('errors'))->toHaveKey('hosting_account_uuid'); // có quyền, account ngoài phạm vi
    $a->account->forceFill(['lifecycle_state' => 'suspended'])->save();
    expect($open($sa)->json('code'))->toBe('invalid_state_transition');
    $a->account->forceFill(['lifecycle_state' => 'active'])->save();

    $agent->on('pty.open', fn () => ['__error' => ['quota_exceeded', 'tối đa 2 phiên', false]]);
    $busy = $open($sa);
    assertMatchesContract(T6A, 'post', '/api/v1/admin/terminal/sessions', 409, $busy);
    expect($busy->json('code'))->toBe('resource_locked')
        ->and(TerminalSession::query()->latest('id')->first())->ended_reason->toBe('error');
    $agent->on('pty.open', fn () => ['__error' => ['dependency_unavailable', 'chưa bật socket', true]]);
    $down = $open($sa);
    assertMatchesContract(T6A, 'post', '/api/v1/admin/terminal/sessions', 503, $down);

    // Chưa step-up (quá hạn step-up) → 403 mfa_step_up_required.
    $this->travel(2)->hours();
    $stale = $open($sa);
    expect($stale->status())->toBe(403)->and($stale->json('code'))->toBe('mfa_step_up_required');
});

it('itso:terminal-reap đóng bản ghi phiên quá 12 giờ', function () {
    $a = new Actors($this);
    $mk = fn (int $h) => TerminalSession::query()->create(['user_id' => $a->owner->id, 'server_id' => $a->server->id,
        'hosting_account_id' => $a->account->id, 'unix_uid' => $a->account->uid, 'mode' => 'account', 'started_at' => now()->subHours($h)]);
    $old = $mk(13);
    $new = $mk(1);
    $this->artisan('itso:terminal-reap')->assertSuccessful();
    expect($old->refresh())->ended_reason->toBe('expired')->ended_at->not->toBeNull()
        ->and($new->refresh()->ended_at)->toBeNull();
});
