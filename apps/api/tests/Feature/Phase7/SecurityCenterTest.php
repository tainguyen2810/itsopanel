<?php

use App\Domain\Security\SecurityEvents;
use App\Models\FimChange;
use App\Models\FirewallApply;
use App\Models\SecurityEvent;
use App\Models\SecuritySetting;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 7.4: SSH hardening, fail2ban, FIM, điểm bảo mật, sự kiện, IP allowlist.

require_once __DIR__.'/helpers.php';

/** Dữ kiện security.audit của máy vừa cài xong (Ubuntu 24.04 + wizard ITSO): SSH còn mật khẩu. */
function p7facts(array $over = []): array
{
    return array_replace_recursive([
        'sshd' => ['port' => 22, 'permit_root_login' => 'prohibit-password', 'password_authentication' => true, 'max_auth_tries' => 6],
        'firewall' => ['table_present' => true, 'input_policy' => 'drop', 'rules' => 1],
        'fail2ban' => ['running' => true, 'jails' => 3],
        'updates' => ['unattended_upgrades' => true, 'pending_security' => 0, 'reboot_required' => false],
        'packages' => ['modsecurity' => true, 'crs' => true, 'clamav' => true, 'yara' => true],
        'fim' => ['baseline_present' => true, 'changes' => 0],
    ], $over);
}

function p7agent(array $over = []): FakeAgent
{
    return new FakeAgent($over + [
        'security.audit' => fn () => p7facts(),
        'sshd.config.apply' => fn (array $env) => ['token' => 'tok_ssh_'.str_repeat('x', 40), 'rollback_at' => Carbon::now()->addSeconds(120)->toIso8601String(),
            'sshd_test' => 'ok', 'changed' => true, 'admin_keys' => 2],
        'sshd.config.confirm' => fn () => ['confirmed' => true, 'rolled_back' => false],
        'firewall.apply' => fn () => ['token' => 'tok_fw_'.str_repeat('y', 40), 'rollback_at' => Carbon::now()->addSeconds(120)->toIso8601String(),
            'ruleset_sha256' => str_repeat('cd', 32), 'rules_active' => 1, 'changed' => true],
        'firewall.confirm' => fn () => ['confirmed' => true, 'rolled_back' => false],
        'fail2ban.status' => fn () => ['running' => true, 'jails' => [
            ['name' => 'sshd', 'enabled' => true, 'total_banned' => 2, 'banned' => [
                ['ip' => '203.0.113.45', 'banned_at' => '2026-11-21T08:00:00Z', 'expires_at' => '2026-11-21T09:00:00Z'],
                ['ip' => '2001:db8::7', 'banned_at' => '2026-11-21T08:30:00Z', 'expires_at' => null]]],
            ['name' => 'itso-panel', 'enabled' => true, 'total_banned' => 0, 'banned' => []],
        ]],
        'fim.check' => fn () => ['checked' => 812, 'baseline_at' => '2026-11-20T03:00:00Z', 'changes' => [
            ['path' => '/etc/ssh/sshd_config', 'change' => 'modified', 'old_sha256' => str_repeat('a', 64), 'new_sha256' => str_repeat('b', 64), 'mode' => 420, 'owner' => 'root'],
            ['path' => '/usr/local/bin/xmrig', 'change' => 'added', 'old_sha256' => null, 'new_sha256' => str_repeat('c', 64), 'mode' => 493, 'owner' => 'root'],
        ]],
        'fim.baseline' => fn () => ['files' => 812, 'sha256' => str_repeat('e', 64), 'created_at' => '2026-11-21T09:00:00Z'],
        '*' => fn () => ['changed' => true, 'reloaded' => true, 'jails_active' => 3, 'unbanned' => true],
    ]);
}

it('điểm bảo mật mặc định ≥ 80 với dữ kiện sau cài; trọng số công khai tổng 100; hạng theo ngưỡng', function () {
    $agent = p7agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    // Mọi quản trị viên đã bật MFA (Actors chỉ bật cho người đăng nhập): bật nốt cho ADMIN.
    $a->spa('AD_IN');
    $a->spa('AD_OUT');
    $r = $sa->get('/api/v1/admin/security/score?server='.$a->server->uuid);
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/score', 200, $r);
    expect(array_sum(array_column($r->json('data.items'), 'weight')))->toBe(100)
        ->and($r->json('data.score'))->toBeGreaterThanOrEqual(80)->and($r->json('data.grade'))->toBe('B');
    $items = collect($r->json('data.items'))->keyBy('key');
    expect($items['ssh_password_disabled']['status'])->toBe('fail')->and($items['admin_ip_allowlist']['earned'])->toBe(5)->and($items['cis_l1']['status'])->toBe('warn')
        ->and($items['admin_mfa']['status'])->toBe('pass');

    $ov = $sa->get('/api/v1/admin/security/overview');
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/overview', 200, $ov);
    expect($ov->json('data.checks'))->not->toBeEmpty();

    // Không có dữ kiện (agent im lặng) → các mục máy chủ chỉ được nửa điểm, không 500.
    SecuritySetting::query()->delete();
    $agent->on('security.audit', fn () => ['__error' => ['dependency_unavailable', 'không có']]);
    $r = $sa->get('/api/v1/admin/security/score?server='.$a->server->uuid);
    expect($r->status())->toBe(200)->and($r->json('data.score'))->toBeLessThan(80);
});

it('SSH: đọc, đổi (safe-apply + step-up), xác nhận; tắt mật khẩu khi chưa có khóa → 422; đổi port mở tường lửa trước', function () {
    $agent = p7agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $q = '?server='.$a->server->uuid;
    $g = $sa->get("/api/v1/admin/security/ssh$q");
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/ssh', 200, $g);

    $r = p7($sa, 'PATCH', "/api/v1/admin/security/ssh$q", ['max_auth_tries' => 3, 'rollback_after_sec' => 120]);
    assertMatchesContract(P7A, 'patch', '/api/v1/admin/security/ssh', 202, $r);
    expect($agent->ops())->toContain('sshd.config.apply');
    $call = collect($agent->calls)->firstWhere('op', 'sshd.config.apply');
    expect($call['params'])->toMatchArray(['port' => 22, 'max_auth_tries' => 3, 'permit_root_login' => 'prohibit-password',
        'login_grace_sec' => 60, 'admin_user' => 'root', 'client_ip' => '127.0.0.1', 'confirm_within_sec' => 120]);
    expect(SecuritySetting::query()->find($a->server->id)->ssh['admin_keys'])->toBe(2);
    $c = p7($sa, 'POST', "/api/v1/admin/security/ssh:confirm$q");
    assertMatchesContract(P7A, 'post', '/api/v1/admin/security/ssh:confirm', 202, $c);
    expect($c->json('job.state'))->toBe('succeeded');
    expect($sa->get("/api/v1/admin/security/ssh$q")->json('data.max_auth_tries'))->toBe(3);

    // Agent đếm được 0 khóa admin → lần sau tắt mật khẩu bị chặn ở panel.
    SecuritySetting::query()->whereKey($a->server->id)->update(['ssh' => json_encode(['max_auth_tries' => 3, 'admin_keys' => 0])]);
    $lock = p7($sa, 'PATCH', "/api/v1/admin/security/ssh$q", ['password_authentication' => false, 'rollback_after_sec' => 120]);
    assertMatchesContract(P7A, 'patch', '/api/v1/admin/security/ssh', 422, $lock);
    expect($lock->json('code'))->toBe('would_lock_out');

    // Đổi port: job 2 bước (tường lửa mở 22 + 2222, rồi sshd); một lần confirm xác nhận cả hai.
    $n = count($agent->calls);
    $p = p7($sa, 'PATCH', "/api/v1/admin/security/ssh$q", ['port' => 2222, 'rollback_after_sec' => 120]);
    expect($p->json('job.steps.*.op'))->toBe(['firewall.apply', 'sshd.config.apply']);
    $fw = $agent->calls[$n]['params'];
    expect($fw['anti_lockout']['ssh_port'])->toBe(2222)->and(collect($fw['rules'])->pluck('ports')->all())->toContain('22,2222');
    $c2 = p7($sa, 'POST', "/api/v1/admin/security/ssh:confirm$q");
    expect($c2->json('job.steps.*.op'))->toBe(['firewall.confirm', 'sshd.config.confirm'])->and($c2->json('job.state'))->toBe('succeeded');
    expect(FirewallApply::query()->where('status', 'confirmed')->count())->toBe(3)
        ->and($sa->get("/api/v1/admin/security/ssh$q")->json('data.port'))->toBe(2222);
    // Cổng panel không làm cổng SSH.
    expect(p7($sa, 'PATCH', "/api/v1/admin/security/ssh$q", ['port' => 8443, 'rollback_after_sec' => 60])->status())->toBe(422);
});

it('fail2ban: đọc kèm số IP bị cấm, đổi jail (ignoreip = allowlist), danh sách cấm, gỡ cấm', function () {
    $agent = p7agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    DB::table('ip_allowlist')->insert(['cidr' => '127.0.0.1/32', 'scope' => 'admin', 'note' => 'local', 'created_at' => now(), 'updated_at' => now()]);
    $q = '?server='.$a->server->uuid;
    $g = $sa->get("/api/v1/admin/security/fail2ban$q");
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/fail2ban', 200, $g);
    expect(array_column($g->json('data.jails'), 'name'))->toBe(['sshd', 'itso-panel', 'pure-ftpd'])
        ->and($g->json('data.jails.0.banned_count'))->toBe(2);

    $u = p7($sa, 'PATCH', "/api/v1/admin/security/fail2ban$q", ['jails' => [['name' => 'itso-panel', 'maxretry' => 3, 'bantime_sec' => 7200]]]);
    assertMatchesContract(P7A, 'patch', '/api/v1/admin/security/fail2ban', 202, $u);
    $p = collect($agent->calls)->firstWhere('op', 'fail2ban.apply')['params'];
    expect($p['ignoreip'])->toBe(['127.0.0.1/32'])->and($p['jails'][1])->toMatchArray(['name' => 'itso-panel', 'maxretry' => 3, 'bantime_sec' => 7200]);
    expect(p7($sa, 'PATCH', "/api/v1/admin/security/fail2ban$q", ['jails' => [['name' => 'nginx']]])->status())->toBe(422)
        ->and(p7($sa, 'PATCH', "/api/v1/admin/security/fail2ban$q", ['jails' => [['name' => 'sshd', 'bantime_sec' => 5]]])->status())->toBe(422);

    $b = $sa->get('/api/v1/admin/security/fail2ban/bans');
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/fail2ban/bans', 200, $b);
    expect($b->json('data.0.ip'))->toBe('2001:db8::7');
    $ub = p7($sa, 'POST', '/api/v1/admin/security/fail2ban/bans:unban', ['server' => $a->server->uuid, 'jail' => 'sshd', 'ip' => '203.0.113.45']);
    assertMatchesContract(P7A, 'post', '/api/v1/admin/security/fail2ban/bans:unban', 202, $ub);
    expect(collect($agent->calls)->last()['params'])->toEqual(['jail' => 'sshd', 'ip' => '203.0.113.45']);
    expect(p7($sa, 'POST', '/api/v1/admin/security/fail2ban/bans:unban', ['server' => $a->server->uuid, 'jail' => 'sshd', 'ip' => '1.2.3.4; rm'])->status())->toBe(422);
    // ADMIN trong phạm vi: xem + gỡ cấm được, không đổi cấu hình fail2ban.
    $ad = $a->spa('AD_IN');
    expect($ad->get('/api/v1/admin/security/fail2ban/bans')->status())->toBe(200)
        ->and($ad->get("/api/v1/admin/security/fail2ban$q")->status())->toBe(403);
});

it('FIM: itso:fim-check ghi thay đổi + sự kiện (không trùng lặp), danh sách, chụp lại baseline (step-up) xác nhận hết', function () {
    $agent = p7agent();
    $a = new Actors($this);
    $this->artisan('itso:fim-check')->assertSuccessful();
    $this->artisan('itso:fim-check')->assertSuccessful();
    // Actors có 2 máy chủ (agent giả trả cùng thay đổi cho mỗi máy): mỗi máy 2 thay đổi, 1 sự kiện.
    expect(FimChange::query()->where('server_id', $a->server->id)->count())->toBe(2)
        ->and(SecurityEvent::query()->where('type', 'fim.changed')->where('server_id', $a->server->id)->count())->toBe(1);
    $sa = $a->spa('SA');
    $l = $sa->get('/api/v1/admin/security/fim/changes?filter[server]='.$a->server->uuid);
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/fim/changes', 200, $l);
    expect($l->json('data'))->toHaveCount(2);
    $b = p7($sa, 'POST', '/api/v1/admin/servers/'.$a->server->uuid.'/fim:baseline');
    assertMatchesContract(P7A, 'post', '/api/v1/admin/servers/{id}/fim:baseline', 202, $b);
    expect(FimChange::query()->where('server_id', $a->server->id)->whereNull('acknowledged_at')->count())->toBe(0)
        ->and(SecuritySetting::query()->find($a->server->id)->fim_baseline_at)->not->toBeNull();
});

it('sự kiện bảo mật: lọc theo mức, xác nhận; ADMIN ngoài phạm vi không thấy', function () {
    p7agent();
    $a = new Actors($this);
    app(SecurityEvents::class)->record('malware.found', 'high', 'Thấy shell.php', $a->server->id, null, '203.0.113.9');
    app(SecurityEvents::class)->record('waf.burst', 'medium', 'WAF chặn nhiều', $a->server->id);
    expect(DB::table('notifications')->where('type', 'security.malware.found')->pluck('user_id')->sort()->values()->all())
        ->toBe(collect([$a->sa->id, $a->adminIn->id])->sort()->values()->all());
    $in = $a->spa('AD_IN');
    $l = $in->get('/api/v1/admin/security/events?filter[severity]=high');
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/events', 200, $l);
    expect($l->json('data'))->toHaveCount(1);
    $id = $l->json('data.0.uuid');
    $ack = $in->post("/api/v1/admin/security/events/$id:acknowledge");
    assertMatchesContract(P7A, 'post', '/api/v1/admin/security/events/{id}:acknowledge', 200, $ack);
    expect($ack->json('data.acknowledged_at'))->not->toBeNull();
    expect($a->spa('AD_OUT')->get('/api/v1/admin/security/events')->json('data'))->toBe([])
        ->and($a->spa('AD_OUT')->post("/api/v1/admin/security/events/$id:acknowledge")->status())->toBe(404);
});

it('IP allowlist: từ chối danh sách không chứa IP hiện tại (would_lock_out), cần step-up, chuẩn hóa CIDR, chặn IP ngoài danh sách', function () {
    p7agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $sa->ip = '10.10.5.20';
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/ip-allowlist', 200, $sa->get('/api/v1/admin/security/ip-allowlist'));
    $bad = $sa->call('PUT', '/api/v1/admin/security/ip-allowlist', ['entries' => [['cidr' => '203.0.113.0/24', 'note' => 'VPN']]]);
    assertMatchesContract(P7A, 'put', '/api/v1/admin/security/ip-allowlist', 422, $bad);
    expect($bad->json('code'))->toBe('would_lock_out');
    expect($sa->call('PUT', '/api/v1/admin/security/ip-allowlist', ['entries' => [['cidr' => '10.10.5.1/16', 'note' => 'x']]])->status())->toBe(422);
    $ok = $sa->call('PUT', '/api/v1/admin/security/ip-allowlist', ['entries' => [['cidr' => '10.10.0.0/16', 'note' => 'Văn phòng'], ['cidr' => '203.0.113.7', 'note' => 'VPN']]]);
    assertMatchesContract(P7A, 'put', '/api/v1/admin/security/ip-allowlist', 200, $ok);
    expect(array_column($ok->json('data.entries'), 'cidr'))->toBe(['10.10.0.0/16', '203.0.113.7/32']);
    // IP ngoài danh sách bị chặn ở realm admin; danh sách rỗng = mở lại.
    $sa->ip = '198.51.100.1';
    expect($sa->get('/api/v1/admin/security/ip-allowlist')->json('code'))->toBe('ip_not_allowed');
    $sa->ip = '10.10.5.20';
    expect($sa->call('PUT', '/api/v1/admin/security/ip-allowlist', ['entries' => []])->status())->toBe(200);
    // ADMIN không có quyền security.server.
    expect($a->spa('AD_IN')->get('/api/v1/admin/security/ip-allowlist')->status())->toBe(403);
});
