<?php

use App\Models\Agent;
use App\Models\AuditLog;
use App\Models\CisResult;
use App\Models\Job;
use Illuminate\Support\Str;
use Tests\Support\Actors;

require_once __DIR__.'/../Phase8/helpers.php';

// Prompt 12.4: CIS API (D-109, ADR 0054) + mục CIS trong điểm bảo mật; header bảo mật, giới hạn body, cookie Secure (ASVS L2).

/** cis.audit giả: 10 mục (7 pass, 2 fail, 1 na). */
function p12cis(): array
{
    $it = fn (string $id, string $g, string $st) => ['id' => $id, 'group' => $g, 'title' => "Mục $id", 'status' => $st, 'evidence' => "bằng chứng $id"];

    return ['profile' => 'ubuntu24.04-l1-hosting', 'items' => [
        $it('1.1.2.3', 'filesystem', 'pass'), $it('1.5.1', 'access', 'pass'), $it('1.5.3', 'access', 'fail'),
        $it('2.1.1', 'services', 'pass'), $it('3.3.1', 'network', 'na'), $it('4.1.1', 'network', 'pass'),
        $it('5.1.21', 'access', 'fail'), $it('6.2.1.1', 'logging', 'pass'), $it('7.1.1', 'filesystem', 'pass'), $it('8.1.1', 'updates', 'pass'),
    ]];
}

it('CIS: chưa kiểm → báo cáo rỗng; chạy kiểm (job chỉ đọc) → lưu kết quả, điểm = pass/(pass+fail), hướng dẫn + fix_href; điểm bảo mật có mục cis_l1', function () {
    $errors = [];
    $agent = p8agent($errors, ['cis.audit' => fn () => p12cis()]);
    $a = new Actors($this);
    Agent::query()->create(['server_id' => $a->server->id, 'transport' => 'local', 'last_seen_at' => now()]);
    $sa = $a->spa('SA');
    $q = '?server='.$a->server->uuid;

    $r = $sa->get('/api/v1/admin/security/cis'.$q);
    assertMatchesContract(P8A, 'get', '/api/v1/admin/security/cis', 200, $r);
    expect($r->json('data'))->toMatchArray(['audited_at' => null, 'score' => 0, 'items' => []]);

    $j = p8($sa, 'POST', '/api/v1/admin/security/cis:audit'.$q);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/security/cis:audit', 202, $j);
    expect($j->json('job.type'))->toBe('cis.audit')->and($agent->calls[0]['params'])->toBe(['profile' => 'ubuntu24.04-l1-hosting'])
        ->and(Job::query()->where('type', 'cis.audit')->value('state'))->toBe('succeeded');

    $r = $sa->get('/api/v1/admin/security/cis'.$q);
    assertMatchesContract(P8A, 'get', '/api/v1/admin/security/cis', 200, $r);
    $items = collect($r->json('data.items'))->keyBy('id');
    expect($r->json('data'))->toMatchArray(['score' => 78, 'passed' => 7, 'failed' => 2, 'not_applicable' => 1])
        ->and($items['5.1.21']['fix_href'])->toBe('/admin/security/ssh')->and($items['5.1.21']['remediation'])->toContain('mật khẩu')
        ->and($items['4.1.1']['fix_href'])->toBe("/admin/servers/{$a->server->uuid}/firewall")->and($items['4.1.1']['remediation'])->toBeNull()
        ->and($items['1.5.3']['remediation'])->toContain('suid_dumpable')
        ->and(AuditLog::query()->where('action', 'security.cis_audit')->count())->toBe(1);

    $score = collect($sa->get('/api/v1/admin/security/score'.$q)->json('data.items'))->keyBy('key');
    expect($score['cis_l1'])->toMatchArray(['status' => 'warn', 'weight' => 5, 'earned' => 2]);

    // Chỉ giữ 30 lượt mỗi server.
    for ($i = 0; $i < 31; $i++) {
        p8($sa, 'POST', '/api/v1/admin/security/cis:audit'.$q)->assertStatus(202);
    }
    expect(CisResult::query()->where('server_id', $a->server->id)->count())->toBe(30);

    // ADMIN trong phạm vi xem được, không chạy kiểm được; ADMIN ngoài phạm vi 404.
    expect($a->spa('AD_IN')->get('/api/v1/admin/security/cis'.$q)->status())->toBe(200)
        ->and(p8($a->spa('AD_IN'), 'POST', '/api/v1/admin/security/cis:audit'.$q)->status())->toBe(403)
        ->and($a->spa('AD_OUT')->get('/api/v1/admin/security/cis'.$q)->status())->toBe(404);
    expect($errors)->toBe([]);
});

it('header bảo mật trên mọi phản hồi API; JSON không cache; body quá lớn → 413 payload_too_large', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $r = $sa->get('/api/v1/admin/me');
    expect($r->headers->get('X-Content-Type-Options'))->toBe('nosniff')
        ->and($r->headers->get('X-Frame-Options'))->toBe('DENY')
        ->and($r->headers->get('Referrer-Policy'))->toBe('same-origin')
        ->and($r->headers->get('Content-Security-Policy'))->toContain("frame-ancestors 'none'")
        ->and($r->headers->get('Cache-Control'))->toContain('no-store');
    expect($this->getJson('/api/v1/auth/me')->headers->get('X-Frame-Options'))->toBe('DENY');

    config(['itso.max_body_kb' => 4]);
    $big = $sa->call('POST', '/api/v1/admin/hosting-packages', ['name' => str_repeat('a', 6000)], ['Idempotency-Key' => (string) Str::uuid()]);
    expect($big->status())->toBe(413)->and($big->json('code'))->toBe('payload_too_large');
});

it('cookie phiên Secure mặc định ở production', function () {
    expect(require base_path('config/session.php'))->toHaveKey('secure');
    $this->app['env'] = 'production';
    putenv('APP_ENV=production');
    $_ENV['APP_ENV'] = $_SERVER['APP_ENV'] = 'production';
    $cfg = require base_path('config/session.php');
    putenv('APP_ENV=testing');
    $_ENV['APP_ENV'] = $_SERVER['APP_ENV'] = 'testing';
    expect($cfg['secure'])->toBeTrue();
});
