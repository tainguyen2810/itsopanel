<?php

use App\Domain\Security\FirewallRuleset;
use App\Domain\Security\Net;
use App\Models\FirewallApply;
use App\Models\FirewallRule;
use App\Models\Job;
use App\Models\SecurityEvent;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 7.4: tường lửa safe-apply (D-76, ADR 0023) qua API admin.

require_once __DIR__.'/helpers.php';

function p7fw(array $over = []): FakeAgent
{
    return new FakeAgent($over + [
        'firewall.apply' => fn (array $env) => ['token' => P7TOKEN, 'rollback_at' => Carbon::now()->addSeconds((int) $env['params']['confirm_within_sec'])->toIso8601String(),
            'ruleset_sha256' => str_repeat('ab', 32), 'rules_active' => count($env['params']['rules']), 'changed' => true],
        'firewall.confirm' => fn (array $env) => $env['params']['token'] === P7TOKEN ? ['confirmed' => true, 'rolled_back' => false]
            : ['__error' => ['precondition_failed', 'token sai']],
        '*' => fn () => [],
    ]);
}

function p7goldenRules(): array
{
    $r = fn (int $p, string $a, ?string $ports, string $src, string $c, string $dir = 'in', string $proto = 'tcp') => ['priority' => $p,
        'action' => $a, 'direction' => $dir, 'protocol' => $proto, 'ports' => $ports, 'source' => $src, 'comment' => $c];

    return [$r(20, 'accept', '80,443', '0.0.0.0/0', 'Web'), $r(10, 'accept', '22', '10.10.0.0/16', 'SSH chỉ từ mạng nội bộ'),
        $r(30, 'accept', '8443', '10.10.0.0/16', 'Admin Panel'), $r(40, 'drop', '3306', '0.0.0.0/0', 'Chặn MySQL'),
        $r(50, 'accept', '51820', '2001:db8::/32', '', 'in', 'udp'), $r(60, 'reject', '25', '0.0.0.0/0', 'Chặn SMTP ra', 'out', 'any'),
        $r(70, 'accept', null, '10.0.0.0/8', '', 'in', 'icmp')];
}

it('ruleset PHP (xem trước) giống hệt golden của agent: hai bản renderer không lệch nhau', function () {
    $rules = p7goldenRules();
    usort($rules, fn ($a, $b) => $a['priority'] <=> $b['priority']);
    FirewallRuleset::check($rules, 22, 8443, '10.10.5.20');
    $php = FirewallRuleset::render($rules, 22, 8443, '10.10.5.20');
    $golden = file_get_contents(dirname(base_path(), 2).'/agent/internal/ops/testdata/golden/firewall.nft');
    // Golden là bảng đang nạp trong Sim (bỏ dòng chú thích + cặp table/delete đầu script).
    expect(implode("\n", array_slice(explode("\n", $php), 3)))->toBe($golden);
});

it('bất biến chống tự khóa dùng chung vector với agent (evil-inputs firewall_rule, cidr)', function () {
    $vec = json_decode(file_get_contents(dirname(base_path(), 2).'/contracts/test-vectors/evil-inputs.json'), true)['categories'];
    foreach ($vec['firewall_rule']['vectors'] as $v) {
        $in = $v['input'];
        $bad = FirewallRuleset::invalid($in) !== null || FirewallRuleset::locksOut($in, 22, 8443, '10.10.5.20');
        $mustReject = $v['expect'] === 'reject' || str_contains($v['note'], 'từ chối');
        expect($bad)->toBe($mustReject, $v['note']);
    }
    foreach ($vec['cidr']['vectors'] as $v) {
        $mustReject = $v['expect'] === 'reject' || str_contains($v['note'], 'từ chối');
        expect(Net::cidr($v['input']) === null)->toBe($mustReject, $v['note']);
    }
    // IPv4-mapped IPv6 của client vẫn bị bắt; nguồn ::/0 phủ mọi IP.
    expect(FirewallRuleset::locksOut(['direction' => 'in', 'action' => 'drop', 'protocol' => 'tcp', 'ports' => '22', 'source' => '10.10.5.0/24'], 22, 8443, '::ffff:10.10.5.20'))->toBeTrue()
        ->and(FirewallRuleset::locksOut(['direction' => 'in', 'action' => 'reject', 'protocol' => 'any', 'ports' => null, 'source' => '::/0'], 22, 8443, '10.10.5.20'))->toBeTrue()
        ->and(FirewallRuleset::locksOut(['direction' => 'in', 'action' => 'drop', 'protocol' => 'icmp', 'ports' => null, 'source' => '0.0.0.0/0'], 22, 8443, '10.10.5.20'))->toBeFalse()
        ->and(FirewallRuleset::locksOut(['direction' => 'out', 'action' => 'drop', 'protocol' => 'tcp', 'ports' => '22', 'source' => '0.0.0.0/0'], 22, 8443, '10.10.5.20'))->toBeFalse();
});

it('rule nháp → xem trước → áp dụng (step-up) → trạng thái chờ → xác nhận bằng request mới; token không lộ', function () {
    $agent = p7fw();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $sa->ip = '10.10.5.20';
    $sid = $a->server->uuid;
    $base = "/api/v1/admin/servers/$sid/firewall";

    $r = p7($sa, 'POST', "$base/rules", ['priority' => 40, 'action' => 'drop', 'direction' => 'in', 'protocol' => 'tcp', 'ports' => '3306',
        'source' => '0.0.0.0/0', 'comment' => 'Chặn MySQL từ ngoài', 'enabled' => true]);
    assertMatchesContract(P7A, 'post', '/api/v1/admin/servers/{id}/firewall/rules', 201, $r);
    p7($sa, 'POST', "$base/rules", ['priority' => 20, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'tcp', 'ports' => '80,443', 'source' => '0.0.0.0/0'])->assertCreated();
    $icmp = p7($sa, 'POST', "$base/rules", ['priority' => 70, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'icmp', 'source' => '10.0.0.0/8']);
    expect($icmp->json('data.ports'))->toBeNull();
    assertMatchesContract(P7A, 'get', '/api/v1/admin/servers/{id}/firewall/rules', 200, $sa->get("$base/rules"));

    // Chống tự khóa ngay khi tạo rule: chặn SSH từ IP đang dùng → 422 would_lock_out; CIDR có bit host / octet > 255 → 422.
    $lock = p7($sa, 'POST', "$base/rules", ['priority' => 5, 'action' => 'drop', 'direction' => 'in', 'protocol' => 'tcp', 'ports' => '22', 'source' => '10.10.5.0/24']);
    assertMatchesContract(P7A, 'post', '/api/v1/admin/servers/{id}/firewall/rules', 422, $lock);
    expect($lock->json('code'))->toBe('would_lock_out');
    expect(p7($sa, 'POST', "$base/rules", ['priority' => 5, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'tcp', 'source' => '10.0.0.1/8'])->json('errors'))->toHaveKey('source')
        ->and(p7($sa, 'POST', "$base/rules", ['priority' => 5, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'tcp', 'source' => '999.1.1.1/8'])->status())->toBe(422)
        ->and(p7($sa, 'POST', "$base/rules", ['priority' => 5, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'tcp', 'ports' => '99999', 'source' => '0.0.0.0/0'])->status())->toBe(422)
        ->and(p7($sa, 'POST', "$base/rules", ['priority' => 5, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'tcp', 'source' => '0.0.0.0/0', 'comment' => "x\"\nadd rule"])->status())->toBe(422);

    $pv = $sa->get("$base/preview");
    assertMatchesContract(P7A, 'get', '/api/v1/admin/servers/{id}/firewall/preview', 200, $pv);
    expect($pv->json('data.lockout_risk'))->toBeFalse()->and($pv->json('data.rules_active'))->toBe(3)
        ->and($pv->json('data.ruleset'))->toContain('ip saddr 10.10.5.20 tcp dport { 22, 8443 } accept')
        ->and($pv->json('data.ruleset'))->toContain('tcp dport 3306 drop comment "Chặn MySQL từ ngoài"');
    expect($sa->get("$base/status")->json('data.state'))->toBe('idle');

    $ap = p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:apply", ['rollback_after_sec' => 120]);
    assertMatchesContract(P7A, 'post', '/api/v1/admin/servers/{id}/firewall:apply', 202, $ap);
    expect($ap->json('job.state'))->toBe('succeeded')->and($agent->ops())->toBe(['firewall.apply']);
    $sent = $agent->calls[0]['params'];
    expect($sent['anti_lockout'])->toEqual(['ssh_port' => 22, 'panel_port' => 8443, 'client_ip' => '10.10.5.20'])
        ->and(array_column($sent['rules'], 'priority'))->toBe([20, 40, 70])
        ->and($agent->calls[0]['op_id'])->toEndWith(':1:0');
    $apply = FirewallApply::query()->sole();
    expect($apply->status)->toBe('pending_confirm')->and($apply->token_hash)->toBe(hash('sha256', P7TOKEN))
        ->and($apply->client_ip)->toBe('10.10.5.20')->and(p7leak(P7TOKEN))->toBeNull();
    $st = $sa->get("$base/status");
    assertMatchesContract(P7A, 'get', '/api/v1/admin/servers/{id}/firewall/status', 200, $st);
    expect($st->json('data.state'))->toBe('pending_confirm')->and($st->json('data.rules_active'))->toBe(3)
        ->and($st->json('data.rollback_at'))->not->toBeNull();

    // Một lần chờ cho mỗi máy chủ.
    expect(p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:apply", ['rollback_after_sec' => 120])->status())->toBe(409);

    $cf = p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:confirm");
    assertMatchesContract(P7A, 'post', '/api/v1/admin/servers/{id}/firewall:confirm', 202, $cf);
    expect($cf->json('job.state'))->toBe('succeeded')->and($agent->calls[1]['params'])->toEqual(['apply_id' => $apply->uuid, 'token' => P7TOKEN])
        ->and($apply->refresh()->status)->toBe('confirmed')->and(p7leak(P7TOKEN))->toBeNull();
    expect($sa->get("$base/status")->json('data.state'))->toBe('confirmed');
    expect(p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:confirm")->status())->toBe(409);

    $rid = FirewallRule::query()->where('port_range', '3306')->value('uuid');
    assertMatchesContract(P7A, 'delete', '/api/v1/admin/servers/{id}/firewall/rules/{rule}', 204, p7($sa, 'DELETE', "$base/rules/$rid"));
});

it('xác nhận quá hạn → job thất bại precondition_failed, đánh dấu rolled_back + sự kiện high + thông báo', function () {
    $agent = p7fw();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $sid = $a->server->uuid;
    p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:apply", ['rollback_after_sec' => 30])->assertStatus(202);
    $this->travel(31)->seconds();
    $cf = p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:confirm");
    expect($cf->json('job.state'))->toBe('failed')->and($cf->json('job.error.code'))->toBe('precondition_failed')
        ->and($agent->ops())->toBe(['firewall.apply']);
    expect(FirewallApply::query()->sole()->status)->toBe('rolled_back');
    $ev = SecurityEvent::query()->sole();
    expect($ev->type)->toBe('firewall.rolled_back')->and($ev->severity)->toBe('high')
        ->and(DB::table('notifications')->where('user_id', $a->sa->id)->where('type', 'security.firewall.rolled_back')->exists())->toBeTrue();
    // Sau hạn: không còn lần chờ → 409; lệnh lịch đánh dấu các lần chờ quá hạn khác.
    expect(p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:confirm")->status())->toBe(409);
    p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:apply", ['rollback_after_sec' => 30])->assertStatus(202);
    $this->travel(60)->seconds();
    $this->artisan('itso:security-audit --expire-only')->assertSuccessful();
    expect(FirewallApply::query()->where('status', 'rolled_back')->count())->toBe(2);
});

it('apply từ chối danh sách tự khóa (422 would_lock_out) và agent báo would_lock_out → job thất bại, không còn chờ', function () {
    $agent = p7fw(['firewall.apply' => fn () => ['__error' => ['would_lock_out', 'rule chặn SSH']]]);
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $sid = $a->server->uuid;
    // Rule được tạo khi đang ở IP khác, rồi áp dụng từ IP bị chặn.
    $sa->ip = '198.51.100.7';
    p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall/rules", ['priority' => 5, 'action' => 'drop', 'direction' => 'in', 'protocol' => 'tcp', 'ports' => '22', 'source' => '10.10.5.0/24'])->assertCreated();
    $sa->ip = '10.10.5.20';
    $pv = $sa->get("/api/v1/admin/servers/$sid/firewall/preview");
    expect($pv->json('data.lockout_risk'))->toBeTrue()->and($pv->json('data.warnings.0'))->toContain('10.10.5.20');
    $r = p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:apply", ['rollback_after_sec' => 120]);
    assertMatchesContract(P7A, 'post', '/api/v1/admin/servers/{id}/firewall:apply', 422, $r);
    expect($r->json('code'))->toBe('would_lock_out')->and($agent->ops())->toBe([])->and(FirewallApply::query()->count())->toBe(0);

    $sa->ip = '198.51.100.7';
    $r = p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:apply", ['rollback_after_sec' => 120]);
    expect($r->json('job.state'))->toBe('failed')->and($r->json('job.error.code'))->toBe('would_lock_out')
        ->and(FirewallApply::query()->sole()->status)->toBe('failed');
});

it('ma trận quyền: tường lửa chỉ SUPER_ADMIN; apply cần step-up; ngoài phạm vi 404', function () {
    p7fw();
    $a = new Actors($this);
    $sid = $a->server->uuid;
    foreach (['AD_IN', 'AD_OUT'] as $p) {
        expect($a->spa($p)->get("/api/v1/admin/servers/$sid/firewall/rules")->status())->toBe(403);
    }
    expect($a->spa('US_OWNER')->get("/api/v1/admin/servers/$sid/firewall/rules")->status())->toBeIn([401, 403]);
    // SA không step-up (phiên mới, đã MFA nhưng step-up quá hạn) → 403 mfa_step_up_required.
    $sa = $a->spa('SA');
    $this->travel(11)->minutes();
    $r = p7($sa, 'POST', "/api/v1/admin/servers/$sid/firewall:apply", ['rollback_after_sec' => 120]);
    expect($r->status())->toBe(403)->and($r->json('code'))->toBe('mfa_step_up_required');
    expect($sa->get('/api/v1/admin/servers/'.Str::uuid().'/firewall/status')->status())->toBe(404);
    expect(Job::query()->count())->toBe(0);
});
