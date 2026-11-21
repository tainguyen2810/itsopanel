<?php

use App\Domain\Web\CertificateService;
use App\Models\AuditLog;
use App\Models\Certificate;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\Notification;
use App\Models\PhpVersion;
use App\Models\Website;
use App\Models\WebsiteDomain;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;
use Tests\Support\Spa;

// Prompt 5.4: chứng chỉ ACME / tải lên / gia hạn / xóa; bí mật không lộ ra job_steps, job_logs, audit.

const C5A = 'itso-admin-v1.yaml';
const C5P = 'itso-portal-v1.yaml';

function c5(Spa $spa, string $method, string $uri, array $body = []): TestResponse
{
    return $spa->call($method, $uri, $body, ['Idempotency-Key' => (string) Str::uuid()]);
}

/** Cặp chứng chỉ tự ký + khóa với SAN cho trước (openssl của PHP, không chạy lệnh). */
function c5pem(array $sans, int $days = 90): array
{
    $cfg = tempnam(sys_get_temp_dir(), 'itso-ossl');
    file_put_contents($cfg, "[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=".implode(',', array_map(fn ($d) => "DNS:$d", $sans))."\n");
    $opt = ['config' => $cfg, 'private_key_type' => OPENSSL_KEYTYPE_RSA, 'private_key_bits' => 2048, 'digest_alg' => 'sha256'];
    $key = openssl_pkey_new($opt);
    $csr = openssl_csr_new(['commonName' => $sans[0], 'organizationName' => 'Upload CA'], $key, $opt + ['req_extensions' => 'v3']);
    $x = openssl_csr_sign($csr, null, $key, $days, $opt + ['x509_extensions' => 'v3'], random_int(1, PHP_INT_MAX));
    openssl_x509_export($x, $cert);
    openssl_pkey_export($key, $pem, null, $opt);
    @unlink($cfg);

    return [$cert, $pem];
}

function c5agent(array $over = []): FakeAgent
{
    return new FakeAgent($over + [
        'cert.issue' => fn (array $env) => ['cert_uuid' => $env['params']['cert_uuid'], 'issuer' => "Let's Encrypt",
            'not_before' => now()->toIso8601String(), 'not_after' => now()->addDays(90)->toIso8601String(),
            'domains' => $env['params']['domains']],
        'cert.install' => fn (array $env) => ['cert_uuid' => $env['params']['cert_uuid'], 'issuer' => 'Upload CA',
            'not_before' => now()->toIso8601String(), 'not_after' => now()->addDays(90)->toIso8601String(), 'domains' => ['anphat.vn']],
        '*' => fn () => ['ok' => true],
    ]);
}

/** Account mẫu có website PHP anphat.vn (+ www) đã ready. */
function c5site(Actors $a, Spa $sa): Website
{
    PhpVersion::query()->create(['server_id' => $a->server->id, 'version' => '8.3', 'status' => 'ready',
        'extensions' => ['curl'], 'spec_version' => 1, 'observed_version' => 1]);
    $id = c5($sa, 'POST', '/api/v1/admin/websites', ['hosting_account_uuid' => $a->account->uuid, 'primary_domain' => 'anphat.vn',
        'type' => 'php', 'php_version' => '8.3'])->json('resource.uuid');
    c5($sa, 'POST', "/api/v1/admin/websites/$id/domains", ['name' => 'www.anphat.vn', 'type' => 'alias'])->assertStatus(202);

    return Website::query()->where('uuid', $id)->firstOrFail();
}

beforeEach(function () {
    config(['itso.acme.email' => 'ssl@itso.vn', 'itso.acme.directory' => 'letsencrypt', 'itso.acme.allow_pebble' => false]);
});

it('cấp ACME: cert.issue → vhost có tls; chứng chỉ valid, website ssl_mode acme; danh sách khớp hợp đồng (admin + portal)', function () {
    $agent = c5agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $w = c5site($a, $sa);
    $agent->calls = [];

    $r = c5($sa, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'acme', 'domains' => ['anphat.vn', 'WWW.anphat.vn']]);
    assertMatchesContract(C5A, 'post', '/api/v1/admin/websites/{id}/certificates', 202, $r);
    expect($r->json('job.type'))->toBe('certificate.issue')->and($agent->ops())->toBe(['cert.issue', 'nginx.vhost.apply']);
    $c = Certificate::query()->firstOrFail();
    expect($agent->calls[0]['params'])->toMatchArray(['cert_uuid' => $c->uuid, 'domains' => ['anphat.vn', 'www.anphat.vn'],
        'email' => 'ssl@itso.vn', 'directory' => 'letsencrypt', 'renew' => false, 'challenge' => 'http-01'])
        ->and($agent->calls[1]['params']['tls'])->toEqual(['cert_uuid' => $c->uuid, 'hsts' => false, 'force_https' => true])
        ->and($c->status)->toBe('ready')->and($c->acme_account_id)->not->toBeNull()
        ->and($w->refresh())->ssl_mode->toBe('acme')->status->toBe('ready');

    $l = $sa->get('/api/v1/admin/certificates');
    assertMatchesContract(C5A, 'get', '/api/v1/admin/certificates', 200, $l);
    expect($l->json('data.0'))->toMatchArray(['source' => 'acme', 'status' => 'valid', 'issuer' => "Let's Encrypt", 'auto_renew' => true]);
    expect($sa->get('/api/v1/admin/websites/'.$w->uuid)->json('data.certificate_expires_at'))->not->toBeNull();
    $p = $a->spa('US_OWNER')->get('/api/v1/portal/certificates');
    assertMatchesContract(C5P, 'get', '/api/v1/portal/certificates', 200, $p);
    expect($p->json('data'))->toHaveCount(1);
    expect($a->spa('US_OTHER')->get('/api/v1/portal/certificates')->json('data'))->toBe([])
        ->and($a->spa('AD_OUT')->get('/api/v1/admin/certificates')->json('data'))->toBe([]);

    // Domain chưa gắn với website, thiếu email ACME, Pebble chưa cho phép → bị chặn trước khi tạo job.
    $bad = c5($sa, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'acme', 'domains' => ['khac.vn']]);
    assertMatchesContract(C5A, 'post', '/api/v1/admin/websites/{id}/certificates', 422, $bad);
    config(['itso.acme.directory' => 'pebble']);
    $peb = c5($sa, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'acme', 'domains' => ['anphat.vn']]);
    assertMatchesContract(C5A, 'post', '/api/v1/admin/websites/{id}/certificates', 409, $peb);
    config(['itso.acme.directory' => 'letsencrypt', 'itso.acme.email' => null]);
    expect(c5($sa, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'acme', 'domains' => ['anphat.vn']])->status())->toBe(409)
        ->and(Certificate::query()->count())->toBe(1);
});

it('tải lên: kiểm khóa khớp, còn hạn, SAN phủ domain → 422; hợp lệ → cert.install chỉ mang tham chiếu bí mật, gỡ bản ACME cũ', function () {
    $agent = c5agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $w = c5site($a, $sa);
    c5($sa, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'acme', 'domains' => ['anphat.vn']])->assertStatus(202);
    $old = Certificate::query()->firstOrFail();
    $u = "/api/v1/admin/websites/{$w->uuid}/certificates";

    [$cert, $key] = c5pem(['anphat.vn', 'www.anphat.vn']);
    [, $otherKey] = c5pem(['anphat.vn']);
    [$wild, $wildKey] = c5pem(['*.anphat.vn']);
    $cases = [
        'khóa lệch' => [['anphat.vn'], $cert, $otherKey, 'private_key_pem'],
        'SAN thiếu' => [['anphat.vn'], $wild, $wildKey, 'domains'],
        'không phải PEM' => [['anphat.vn'], 'xin chào', $key, 'certificate_pem'],
        'khóa mã hóa/sai dạng' => [['anphat.vn'], $cert, "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n", 'private_key_pem'],
    ];
    foreach ($cases as $name => [$doms, $c, $k, $field]) {
        $r = c5($sa, 'POST', $u, ['source' => 'upload', 'domains' => $doms, 'certificate_pem' => $c, 'private_key_pem' => $k]);
        assertMatchesContract(C5A, 'post', '/api/v1/admin/websites/{id}/certificates', 422, $r);
        expect(array_keys((array) $r->json('errors')))->toContain($field);
    }
    // Wildcard phủ www nhưng không phủ gốc.
    expect(c5($sa, 'POST', $u, ['source' => 'upload', 'domains' => ['www.anphat.vn'], 'certificate_pem' => $wild, 'private_key_pem' => $wildKey])
        ->status())->toBe(202);
    $agent->calls = [];

    $ok = c5($sa, 'POST', $u, ['source' => 'upload', 'domains' => ['anphat.vn', 'www.anphat.vn'], 'certificate_pem' => $cert, 'private_key_pem' => $key]);
    assertMatchesContract(C5A, 'post', '/api/v1/admin/websites/{id}/certificates', 202, $ok);
    $new = Certificate::query()->where('source', 'upload')->latest('id')->firstOrFail();
    expect($agent->ops())->toBe(['cert.install', 'nginx.vhost.apply', 'cert.remove'])
        ->and($agent->calls[0]['params']['private_key_pem'])->toBe(trim($key)."\n") // agent nhận khóa thật
        ->and($agent->calls[1]['params']['tls']['cert_uuid'])->toBe($new->uuid)
        ->and($new->status)->toBe('ready')->and($new->issuer)->toBe('Upload CA')
        ->and($w->refresh()->ssl_mode)->toBe('custom')
        ->and(Certificate::query()->whereKey($old->id)->exists())->toBeFalse();

    // Bí mật: chỉ tham chiếu trong job_steps; không có trong job_logs, audit, phản hồi; khóa trong DB đã mã hóa.
    $step = JobStep::query()->where('job_id', Job::query()->where('uuid', $ok->json('job.uuid'))->value('id'))->where('op', 'cert.install')->firstOrFail();
    expect($step->params_redacted['private_key_pem'])->toBe(['$secret' => 'certificate_key:'.$new->uuid]);
    $needle = trim(explode("\n", trim($key))[1]);
    foreach (['job_steps', 'job_logs', 'audit_logs', 'certificates'] as $t) {
        $hit = DB::table($t)->get()->contains(fn ($row) => str_contains(json_encode($row), $needle));
        expect($hit)->toBeFalse("khóa lộ trong $t");
    }
    expect($ok->getContent())->not->toContain($needle)
        ->and($sa->get('/api/v1/admin/certificates')->getContent())->not->toContain('PRIVATE KEY');
    // Gia hạn chứng chỉ tải lên → 422.
    $rn = c5($sa, 'POST', "/api/v1/admin/certificates/{$new->uuid}:renew");
    assertMatchesContract(C5A, 'post', '/api/v1/admin/certificates/{id}:renew', 422, $rn);
});

it('chứng chỉ tải lên đã hết hạn → 422', function () {
    c5agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $w = c5site($a, $sa);
    [$cert, $key] = c5pem(['anphat.vn'], 1);
    $this->travel(3)->days();
    $sa = $a->spa('SA');
    $r = c5($sa, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'upload', 'domains' => ['anphat.vn'],
        'certificate_pem' => $cert, 'private_key_pem' => $key]);
    expect($r->status())->toBe(422)->and($r->json('errors'))->toHaveKey('certificate_pem');
});

it('gia hạn: itso:certs-renew chọn đúng chứng chỉ ACME < 30 ngày; lỗi → last_error, audit, báo SUPER_ADMIN', function () {
    $fail = false;
    $agent = c5agent(['cert.issue' => function (array $env) use (&$fail) {
        return $fail ? ['__error' => ['precondition_failed', 'lego: urn:ietf:params:acme:error:unauthorized', false]]
            : ['cert_uuid' => $env['params']['cert_uuid'], 'issuer' => "Let's Encrypt", 'not_before' => now()->toIso8601String(),
                'not_after' => now()->addDays(90)->toIso8601String(), 'domains' => $env['params']['domains']];
    }]);
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $w = c5site($a, $sa);
    c5($sa, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'acme', 'domains' => ['anphat.vn']])->assertStatus(202);
    $due = Certificate::query()->firstOrFail();
    $due->forceFill(['not_after' => now()->addDays(10)])->save();
    // Không đến hạn: còn 60 ngày; tắt auto_renew; nguồn upload.
    $base = ['website_id' => $w->id, 'server_id' => $w->server_id, 'domains' => ['anphat.vn'], 'status' => 'ready', 'issuer' => 'X',
        'not_before' => now()->subDay()];
    Certificate::query()->create($base + ['source' => 'acme', 'not_after' => now()->addDays(60), 'auto_renew' => true]);
    Certificate::query()->create($base + ['source' => 'acme', 'not_after' => now()->addDays(5), 'auto_renew' => false]);
    Certificate::query()->create($base + ['source' => 'upload', 'not_after' => now()->addDays(5), 'auto_renew' => false]);
    expect(collect(app(CertificateService::class)->due())->pluck('id')->all())->toBe([$due->id]);
    expect($sa->get('/api/v1/admin/certificates')->json('data'))->toHaveCount(4);

    $agent->calls = [];
    $this->artisan('itso:certs-renew')->assertSuccessful();
    expect($agent->ops())->toBe(['cert.issue'])->and($agent->calls[0]['params']['renew'])->toBeTrue()
        ->and($due->refresh()->not_after->gt(now()->addDays(80)))->toBeTrue()
        ->and(Job::query()->where('type', 'certificate.renew')->value('state'))->toBe('succeeded');

    $due->forceFill(['not_after' => now()->addDays(3)])->save();
    $fail = true;
    $this->artisan('itso:certs-renew')->assertSuccessful();
    expect($due->refresh())->status->toBe('ready')->last_error->toContain('unauthorized')
        ->and(Notification::query()->where('user_id', $a->sa->id)->where('type', 'certificate.renew_failed')->exists())->toBeTrue()
        ->and(AuditLog::query()->where('action', 'certificate.renew')->where('result', 'failure')->exists())->toBeTrue();

    // Gia hạn thủ công qua API.
    $fail = false;
    $r = c5($sa, 'POST', "/api/v1/admin/certificates/{$due->uuid}:renew");
    assertMatchesContract(C5A, 'post', '/api/v1/admin/certificates/{id}:renew', 202, $r);
    assertMatchesContract(C5P, 'post', '/api/v1/portal/certificates/{id}:renew', 202,
        c5($a->spa('US_OWNER'), 'POST', "/api/v1/portal/certificates/{$due->uuid}:renew"));
    expect(c5($a->spa('US_OTHER'), 'POST', "/api/v1/portal/certificates/{$due->uuid}:renew")->status())->toBe(404);
});

it('xóa chứng chỉ đang dùng: vhost bỏ tls rồi cert.remove; website ssl_mode none', function () {
    $agent = c5agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $w = c5site($a, $sa);
    c5($sa, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'acme', 'domains' => ['anphat.vn']])->assertStatus(202);
    $c = Certificate::query()->firstOrFail();
    $agent->calls = [];
    $d = c5($sa, 'DELETE', "/api/v1/admin/certificates/{$c->uuid}");
    assertMatchesContract(C5A, 'delete', '/api/v1/admin/certificates/{id}', 202, $d);
    expect($agent->ops())->toBe(['nginx.vhost.apply', 'cert.remove'])->and($agent->calls[0]['params'])->not->toHaveKey('tls')
        ->and(Certificate::query()->count())->toBe(0)->and($w->refresh())->ssl_mode->toBe('none')->status->toBe('ready');
    expect(c5($sa, 'DELETE', "/api/v1/admin/certificates/{$c->uuid}")->status())->toBe(404);
});

it('website tạo với ssl_mode acme: thêm cert.issue + vhost tls; cấp lỗi → site degraded (vẫn chạy HTTP), chứng chỉ failed', function () {
    $fail = false;
    $agent = c5agent(['cert.issue' => function (array $env) use (&$fail) {
        return $fail ? ['__error' => ['precondition_failed', 'lego: domain chưa trỏ về máy', false]]
            : ['cert_uuid' => $env['params']['cert_uuid'], 'issuer' => "Let's Encrypt", 'not_before' => now()->toIso8601String(),
                'not_after' => now()->addDays(90)->toIso8601String(), 'domains' => $env['params']['domains']];
    }]);
    $a = new Actors($this);
    $sa = $a->spa('SA');
    PhpVersion::query()->create(['server_id' => $a->server->id, 'version' => '8.3', 'status' => 'ready', 'extensions' => [],
        'spec_version' => 1, 'observed_version' => 1]);
    $body = ['hosting_account_uuid' => $a->account->uuid, 'type' => 'static', 'ssl_mode' => 'acme'];
    $r = c5($sa, 'POST', '/api/v1/admin/websites', $body + ['primary_domain' => 'anphat.vn']);
    expect($agent->ops())->toBe(['fs.site_layout.ensure', 'nginx.vhost.apply', 'cert.issue', 'nginx.vhost.apply'])
        ->and($agent->calls[3]['params'])->toHaveKey('tls')
        ->and(Website::query()->where('uuid', $r->json('resource.uuid'))->value('status'))->toBe('ready')
        ->and(Certificate::query()->value('status'))->toBe('ready');

    $fail = true;
    $r2 = c5($sa, 'POST', '/api/v1/admin/websites', $body + ['primary_domain' => 'chua-tro.vn']);
    $w2 = Website::query()->where('uuid', $r2->json('resource.uuid'))->firstOrFail();
    expect($w2->status)->toBe('degraded')->and($w2->drift)->toHaveKey('ssl')
        ->and(Certificate::query()->where('website_id', $w2->id)->value('status'))->toBe('failed');
    // Bật ACME qua PATCH website (none → acme) cũng cấp chứng chỉ.
    $fail = false;
    $r3 = c5($sa, 'POST', '/api/v1/admin/websites', ['hosting_account_uuid' => $a->account->uuid, 'type' => 'static', 'primary_domain' => 'sau.vn']);
    $agent->calls = [];
    c5($sa, 'PATCH', '/api/v1/admin/websites/'.$r3->json('resource.uuid'), ['ssl_mode' => 'acme'])->assertStatus(202);
    expect($agent->ops())->toBe(['cert.issue', 'nginx.vhost.apply'])
        ->and(Website::query()->where('uuid', $r3->json('resource.uuid'))->value('ssl_mode'))->toBe('acme');
});

it('ma trận quyền chứng chỉ: ADMIN ngoài phạm vi / USER khác → 404', function () {
    c5agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $w = c5site($a, $sa);
    c5($sa, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'acme', 'domains' => ['anphat.vn']])->assertStatus(202);
    $c = Certificate::query()->firstOrFail();
    $out = $a->spa('AD_OUT');
    expect(c5($out, 'POST', "/api/v1/admin/websites/{$w->uuid}/certificates", ['source' => 'acme', 'domains' => ['anphat.vn']])->status())->toBe(404)
        ->and(c5($out, 'DELETE', "/api/v1/admin/certificates/{$c->uuid}")->status())->toBe(404)
        ->and(c5($a->spa('US_OTHER'), 'DELETE', "/api/v1/portal/certificates/{$c->uuid}")->status())->toBe(404)
        ->and(c5($a->spa('AD_IN'), 'POST', "/api/v1/admin/certificates/{$c->uuid}:renew")->status())->toBe(202);
    $pd = c5($a->spa('US_OWNER'), 'DELETE', "/api/v1/portal/certificates/{$c->uuid}");
    assertMatchesContract(C5P, 'delete', '/api/v1/portal/certificates/{id}', 202, $pd);
    expect(WebsiteDomain::query()->count())->toBe(2);
});
