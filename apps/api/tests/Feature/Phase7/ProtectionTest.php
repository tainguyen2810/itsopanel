<?php

use App\Models\MalwareFinding;
use App\Models\MalwareScan;
use App\Models\QuarantineItem;
use App\Models\SecurityEvent;
use App\Models\WafEvent;
use App\Models\WafSetting;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 7.4: quét mã độc + cách ly (D-79), WAF (D-78), Portal chỉ thấy account của mình.

require_once __DIR__.'/helpers.php';

const P7EICAR = '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f';

function p7site(Actors $a, string $domain = 'shop.anphat.vn'): Website
{
    $id = DB::table('websites')->insertGetId(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id,
        'primary_domain' => $domain, 'status' => 'ready'], 'id');

    return Website::query()->findOrFail($id);
}

function p7malware(array $over = []): FakeAgent
{
    return new FakeAgent($over + [
        'malware.scan' => fn (array $env) => ['files_scanned' => 1840, 'skipped' => 3, 'engine_versions' => ['clamav' => '1.0.7'], 'findings' => [
            ['path' => $env['params']['target'] === '.' ? 'sites/shop.anphat.vn/public/eicar.txt' : $env['params']['target'].'/public/eicar.txt',
                'signature' => 'Eicar-Test-Signature', 'engine' => 'clamav', 'sha256' => P7EICAR, 'size' => 68],
            ['path' => 'sites/shop.anphat.vn/public/wp-content/uploads/x.php', 'signature' => 'ITSO_Webshell_Eval', 'engine' => 'yara',
                'sha256' => str_repeat('d', 64), 'size' => 412]]],
        'malware.quarantine' => fn (array $env) => ['quarantined' => true, 'size' => 68, 'sha256' => $env['params']['expected_sha256']],
        'malware.restore' => fn () => ['restored' => true],
        'malware.delete' => fn () => ['deleted' => true],
        'waf.apply' => fn () => ['available' => true, 'changed' => true, 'nginx_test' => 'ok'],
        'waf.events' => fn (array $env) => $env['params']['cursor'] === null ? ['next_cursor' => '1234:900', 'events' => array_map(fn (int $i) => [
            'website_uuid' => Website::query()->value('uuid'), 'rule_id' => 942100, 'message' => 'SQL Injection Attack Detected via libinjection',
            'severity' => 'critical', 'client_ip' => '203.0.113.66', 'method' => 'GET', 'uri' => '/?id=1%27%20OR%201=1--',
            'action' => 'blocked', 'at' => Carbon::now()->subMinutes($i)->toIso8601String()], range(1, 55))]
            : ['next_cursor' => '1234:900', 'events' => []],
        '*' => fn () => [],
    ]);
}

it('quét website → finding + sự kiện + thông báo; cách ly → khu cách ly; khôi phục (step-up); khớp hợp đồng', function () {
    $agent = p7malware();
    $a = new Actors($this);
    $w = p7site($a);
    $in = $a->spa('AD_IN');
    $r = p7($in, 'POST', "/api/v1/admin/websites/{$w->uuid}/scans");
    assertMatchesContract(P7A, 'post', '/api/v1/admin/websites/{id}/scans', 202, $r);
    expect($r->json('job.state'))->toBe('succeeded');
    expect($agent->calls[0]['params'])->toMatchArray(['account' => ['username' => $a->account->username, 'uid' => $a->account->uid],
        'target' => 'sites/shop.anphat.vn', 'engines' => ['clamav', 'yara'], 'max_file_mb' => 64]);
    $scan = MalwareScan::query()->sole();
    expect($scan->status)->toBe('succeeded')->and($scan->files_scanned)->toBe(1840)->and($scan->findings_count)->toBe(2);
    expect(SecurityEvent::query()->where('type', 'malware.found')->count())->toBe(1);

    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/malware/scans', 200, $in->get('/api/v1/admin/security/malware/scans'));
    $f = $in->get('/api/v1/admin/security/malware/findings?filter[hosting_account]='.$a->account->uuid);
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/malware/findings', 200, $f);
    expect($f->json('data'))->toHaveCount(2);

    $eicar = MalwareFinding::query()->where('engine', 'clamav')->sole();
    $q = p7($in, 'POST', "/api/v1/admin/security/malware/findings/{$eicar->uuid}:quarantine");
    assertMatchesContract(P7A, 'post', '/api/v1/admin/security/malware/findings/{id}:quarantine', 202, $q);
    expect($q->json('resource'))->toBe(['type' => 'malware_finding', 'uuid' => $eicar->uuid])
        ->and(collect($agent->calls)->last()['params'])->toMatchArray(['path' => $eicar->path, 'expected_sha256' => P7EICAR]);
    $item = QuarantineItem::query()->sole();
    expect($item->uuid)->toBe(collect($agent->calls)->last()['params']['item_uuid'])->and($item->signature)->toBe('Eicar-Test-Signature')
        ->and($eicar->refresh()->action)->toBe('quarantined');
    // Đã xử lý → 409.
    expect(p7($in, 'POST', "/api/v1/admin/security/malware/findings/{$eicar->uuid}:quarantine")->status())->toBe(409);
    assertMatchesContract(P7A, 'get', '/api/v1/admin/security/quarantine', 200, $in->get('/api/v1/admin/security/quarantine'));

    $rs = p7($in, 'POST', "/api/v1/admin/security/quarantine/{$item->uuid}:restore");
    assertMatchesContract(P7A, 'post', '/api/v1/admin/security/quarantine/{id}:restore', 202, $rs);
    expect(collect($agent->calls)->last()['params'])->toMatchArray(['item_uuid' => $item->uuid, 'original_path' => $eicar->path, 'overwrite' => false])
        ->and($item->refresh()->restored_at)->not->toBeNull()->and($eicar->refresh()->action)->toBe('restored');

    // Đang quét dở → 409; ADMIN ngoài phạm vi → 404.
    MalwareScan::query()->update(['status' => 'running']);
    expect(p7($in, 'POST', "/api/v1/admin/websites/{$w->uuid}/scans")->status())->toBe(409);
    expect(p7($a->spa('AD_OUT'), 'POST', "/api/v1/admin/websites/{$w->uuid}/scans")->status())->toBe(404)
        ->and($a->spa('AD_OUT')->get('/api/v1/admin/security/malware/findings')->json('data'))->toBe([]);
});

it('Portal: tổng quan bảo vệ, quét account, cách ly, xóa cần step-up; USER khác không thấy (404)', function () {
    $agent = p7malware();
    $a = new Actors($this);
    p7site($a);
    $owner = $a->spa('US_OWNER');
    $s = p7($owner, 'POST', "/api/v1/portal/hosting-accounts/{$a->account->uuid}/scans");
    assertMatchesContract(P7P, 'post', '/api/v1/portal/hosting-accounts/{id}/scans', 202, $s);
    expect($agent->calls[0]['params']['target'])->toBe('.');
    $pr = $owner->get('/api/v1/portal/protection');
    assertMatchesContract(P7P, 'get', '/api/v1/portal/protection', 200, $pr);
    expect($pr->json('data.accounts.0.findings_open'))->toBe(2)->and($pr->json('data.accounts.0.websites.0.waf_mode'))->toBe('detect')
        ->and($pr->json('data.accounts.0.scan_running'))->toBeFalse();
    $list = $owner->get('/api/v1/portal/protection/findings');
    assertMatchesContract(P7P, 'get', '/api/v1/portal/protection/findings', 200, $list);
    $ids = array_column($list->json('data'), 'uuid');
    $q = p7($owner, 'POST', "/api/v1/portal/protection/findings/{$ids[0]}:quarantine");
    assertMatchesContract(P7P, 'post', '/api/v1/portal/protection/findings/{id}:quarantine', 202, $q);

    // Người khác: không thấy, không thao tác được.
    $other = $a->spa('US_OTHER');
    expect($other->get('/api/v1/portal/protection/findings')->json('data'))->toBe([])
        ->and($other->get('/api/v1/portal/protection')->json('data.accounts.0.findings_open'))->toBe(0)
        ->and(p7($other, 'POST', "/api/v1/portal/protection/findings/{$ids[1]}:quarantine")->status())->toBe(404)
        ->and(p7($other, 'POST', "/api/v1/portal/hosting-accounts/{$a->account->uuid}/scans")->status())->toBe(404);

    // Xóa: chưa step-up → 403; sau step-up → job malware.delete kiểm sha256.
    expect(p7($owner, 'DELETE', "/api/v1/portal/protection/findings/{$ids[1]}")->status())->toBe(403);
    Actors::enrollAndStepUp($this, $owner);
    $d = p7($owner, 'DELETE', "/api/v1/portal/protection/findings/{$ids[1]}");
    assertMatchesContract(P7P, 'delete', '/api/v1/portal/protection/findings/{id}', 202, $d);
    expect(collect($agent->calls)->last())->op->toBe('malware.delete')
        ->and(MalwareFinding::query()->where('uuid', $ids[1])->value('action'))->toBe('deleted');
});

it('WAF: mặc định DetectionOnly, đổi sang chặn (ETag/If-Match), đồng bộ sự kiện theo con trỏ + sự kiện chặn dồn dập', function () {
    $agent = p7malware();
    $a = new Actors($this);
    $w = p7site($a);
    $in = $a->spa('AD_IN');
    $g = $in->get("/api/v1/admin/websites/{$w->uuid}/waf");
    assertMatchesContract(P7A, 'get', '/api/v1/admin/websites/{id}/waf', 200, $g);
    expect($g->json('data'))->toMatchArray(['enabled' => true, 'mode' => 'detect', 'paranoia_level' => 1, 'rule_exclusions' => []]);
    $etag = $g->headers->get('ETag');
    expect(p7($in, 'PATCH', "/api/v1/admin/websites/{$w->uuid}/waf", ['mode' => 'block'], ['If-Match' => '"cu"'])->status())->toBe(412);
    $u = p7($in, 'PATCH', "/api/v1/admin/websites/{$w->uuid}/waf", ['mode' => 'block', 'paranoia_level' => 2, 'rule_exclusions' => ['942100']], ['If-Match' => $etag]);
    assertMatchesContract(P7A, 'patch', '/api/v1/admin/websites/{id}/waf', 202, $u);
    expect(collect($agent->calls)->last()['params'])->toMatchArray(['website_uuid' => $w->uuid, 'mode' => 'On', 'paranoia_level' => 2, 'rule_exclusions' => [942100]]);
    expect(WafSetting::query()->find($w->id)->applied_at)->not->toBeNull();
    expect(p7($in, 'PATCH', "/api/v1/admin/websites/{$w->uuid}/waf", ['rule_exclusions' => ['94210; deny']])->status())->toBe(422);

    $this->artisan('itso:waf-events-sync')->assertSuccessful();
    $this->artisan('itso:waf-events-sync')->assertSuccessful();
    expect(WafEvent::query()->count())->toBe(55)
        ->and(SecurityEvent::query()->where('type', 'waf.burst')->count())->toBe(1);
    expect(collect($agent->calls)->where('op', 'waf.events')->pluck('params.cursor')->unique()->values()->all())->toContain(null, '1234:900');
    $ev = $in->get("/api/v1/admin/websites/{$w->uuid}/waf/events?limit=10");
    assertMatchesContract(P7A, 'get', '/api/v1/admin/websites/{id}/waf/events', 200, $ev);
    expect($ev->json('data'))->toHaveCount(10)->and($in->get("/api/v1/admin/websites/{$w->uuid}/waf")->json('data.blocked_24h'))->toBe(55);
    expect($a->spa('AD_OUT')->get("/api/v1/admin/websites/{$w->uuid}/waf")->status())->toBe(404);
});
