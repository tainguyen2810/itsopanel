<?php

use App\Auth\Totp;
use App\Models\Job;
use App\Models\Notification;
use App\Models\PhpVersion;
use App\Models\ServerSoftware;
use App\Models\Website;
use App\Models\WebsiteDomain;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;
use Tests\Support\Spa;

// Prompt 5.3: Website Service + PHP Manager + Nginx toàn server + wizard bước 4, qua API admin và portal.

const W5A = 'itso-admin-v1.yaml';
const W5P = 'itso-portal-v1.yaml';

function w5(Spa $spa, string $method, string $uri, array $body = [], array $headers = []): TestResponse
{
    return $spa->call($method, $uri, $body, $headers + ['Idempotency-Key' => (string) Str::uuid()]);
}

function w5agent(array $over = []): FakeAgent
{
    return new FakeAgent($over + [
        'log.tail' => fn (array $env) => ['lines' => ['127.0.0.1 - - "GET / HTTP/2.0" 200', '127.0.0.1 - - "GET /x HTTP/2.0" 404']],
        '*' => fn () => ['ok' => true],
    ]);
}

function w5php(Actors $a, string $status = 'ready'): void
{
    PhpVersion::query()->create(['server_id' => $a->server->id, 'version' => '8.3', 'status' => $status,
        'extensions' => ['curl', 'intl', 'mbstring', 'opcache', 'xml', 'zip'], 'spec_version' => 1, 'observed_version' => 1]);
}

/** Tạo website PHP qua API (portal hoặc admin); trả response 202. */
function w5create(Spa $spa, Actors $a, string $realm, string $domain, array $over = []): TestResponse
{
    return w5($spa, 'POST', "/api/v1/$realm/websites", $over + ['hosting_account_uuid' => $a->account->uuid,
        'primary_domain' => $domain, 'type' => 'php', 'php_version' => '8.3', 'document_root' => 'public']);
}

it('tạo website PHP: job layout → pool → vhost theo thứ tự, website ready; mọi endpoint đọc khớp hợp đồng (admin + portal)', function () {
    $agent = w5agent();
    $a = new Actors($this);
    w5php($a);
    $in = $a->spa('AD_IN');

    $r = w5create($in, $a, 'admin', 'anphat.vn');
    assertMatchesContract(W5A, 'post', '/api/v1/admin/websites', 202, $r);
    expect($r->json('job.type'))->toBe('website.create')->and($r->json('resource.type'))->toBe('website')
        ->and($agent->ops())->toBe(['fs.site_layout.ensure', 'php.pool.apply', 'nginx.vhost.apply']);
    $vh = $agent->calls[2]['params'];
    expect($vh)->toMatchArray(['site_dir' => 'anphat.vn', 'type' => 'php', 'server_names' => ['anphat.vn'], 'document_root' => 'public',
        'suspended' => false, 'http2' => true])->and($vh)->not->toHaveKey('tls')
        ->and($agent->calls[1]['params'])->toMatchArray(['version' => '8.3', 'pm_max_children' => 4]);
    $id = $r->json('resource.uuid');
    $w = Website::query()->where('uuid', $id)->firstOrFail();
    expect($w)->status->toBe('ready')->observed_version->toBe($w->spec_version);

    $show = $in->get("/api/v1/admin/websites/$id");
    assertMatchesContract(W5A, 'get', '/api/v1/admin/websites/{id}', 200, $show);
    expect($show->headers->get('ETag'))->not->toBeNull();
    assertMatchesContract(W5A, 'get', '/api/v1/admin/websites', 200, $in->get('/api/v1/admin/websites', ['q' => 'anphat']));
    assertMatchesContract(W5A, 'get', '/api/v1/admin/websites/{id}/domains', 200, $in->get("/api/v1/admin/websites/$id/domains"));
    assertMatchesContract(W5A, 'get', '/api/v1/admin/websites/{id}/nginx', 200, $in->get("/api/v1/admin/websites/$id/nginx"));
    assertMatchesContract(W5A, 'get', '/api/v1/admin/websites/{id}/php', 200, $in->get("/api/v1/admin/websites/$id/php"));
    $logs = $in->get("/api/v1/admin/websites/$id/logs?kind=access&lines=50");
    assertMatchesContract(W5A, 'get', '/api/v1/admin/websites/{id}/logs', 200, $logs);
    expect($logs->json('data'))->toHaveCount(2)->and(collect($agent->calls)->last()['params'])->toMatchArray(['kind' => 'access', 'lines' => 50]);
    expect($in->get("/api/v1/admin/websites/$id/logs?kind=nope")->status())->toBe(422);

    $owner = $a->spa('US_OWNER');
    assertMatchesContract(W5P, 'get', '/api/v1/portal/websites', 200, $owner->get('/api/v1/portal/websites'));
    assertMatchesContract(W5P, 'get', '/api/v1/portal/websites/{id}', 200, $owner->get("/api/v1/portal/websites/$id"));
    assertMatchesContract(W5P, 'get', '/api/v1/portal/websites/{id}/domains', 200, $owner->get("/api/v1/portal/websites/$id/domains"));
    assertMatchesContract(W5P, 'get', '/api/v1/portal/websites/{id}/nginx', 200, $owner->get("/api/v1/portal/websites/$id/nginx"));
    assertMatchesContract(W5P, 'get', '/api/v1/portal/websites/{id}/php', 200, $owner->get("/api/v1/portal/websites/$id/php"));
    assertMatchesContract(W5P, 'get', '/api/v1/portal/websites/{id}/logs', 200, $owner->get("/api/v1/portal/websites/$id/logs?kind=error"));
    $pr = w5create($owner, $a, 'portal', 'blog.anphat.vn', ['type' => 'static', 'php_version' => null]);
    assertMatchesContract(W5P, 'post', '/api/v1/portal/websites', 202, $pr);
    expect(array_slice($agent->ops(), -2))->toBe(['fs.site_layout.ensure', 'nginx.vhost.apply']);
});

it('validate + quota: domain sai/trùng/của panel, document_root ngoài public, PHP chưa cài, vượt website_limit → 422/409', function () {
    w5agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    // PHP chưa cài trên server → 409.
    $nophp = w5create($sa, $a, 'admin', 'anphat.vn');
    assertMatchesContract(W5A, 'post', '/api/v1/admin/websites', 409, $nophp);
    w5php($a);
    expect(w5create($sa, $a, 'admin', 'anphat.vn', ['php_version' => '7.4'])->status())->toBe(409);

    foreach (['-bad-.vn', 'localhost', 'a..b.vn', 'x.local'] as $bad) {
        $r = w5create($sa, $a, 'admin', $bad);
        expect($r->status())->toBe(422, $bad)->and($r->json('errors'))->toHaveKey('primary_domain');
    }
    foreach (['../etc', '/var/www', 'dist', 'public/../..'] as $bad) {
        expect(w5create($sa, $a, 'admin', 'anphat.vn', ['document_root' => $bad])->status())->toBe(422, $bad);
    }
    $unknown = w5create($sa, $a, 'admin', 'anphat.vn', ['rogue' => 1]);
    assertMatchesContract(W5A, 'post', '/api/v1/admin/websites', 422, $unknown);

    $a->account->forceFill(['limits_override' => ['website_limit' => 1, 'alias_domain_limit' => 1]])->save();
    w5create($sa, $a, 'admin', 'anphat.vn')->assertStatus(202);
    $dup = w5create($sa, $a, 'admin', 'ANPHAT.vn');
    assertMatchesContract(W5A, 'post', '/api/v1/admin/websites', 409, $dup);
    $q = w5create($sa, $a, 'admin', 'thu-hai.vn');
    assertMatchesContract(W5A, 'post', '/api/v1/admin/websites', 422, $q);
    expect($q->json('code'))->toBe('quota_exceeded');

    $id = Website::query()->where('primary_domain', 'anphat.vn')->value('uuid');
    $d1 = w5($sa, 'POST', "/api/v1/admin/websites/$id/domains", ['name' => 'www.anphat.vn', 'type' => 'alias']);
    assertMatchesContract(W5A, 'post', '/api/v1/admin/websites/{id}/domains', 202, $d1);
    $d2 = w5($sa, 'POST', "/api/v1/admin/websites/$id/domains", ['name' => 'anphat.com.vn', 'type' => 'redirect']);
    assertMatchesContract(W5A, 'post', '/api/v1/admin/websites/{id}/domains', 422, $d2);
    expect($d2->json('code'))->toBe('quota_exceeded');
    expect(w5($sa, 'POST', "/api/v1/admin/websites/$id/domains", ['name' => 'shop.khac.vn', 'type' => 'subdomain'])->status())->toBe(422);
    // Account không hoạt động → không tạo website mới.
    $a->account->forceFill(['lifecycle_state' => 'suspended', 'limits_override' => []])->save();
    expect(w5create($sa, $a, 'admin', 'ba.vn')->status())->toBe(409);
});

it('sửa website/nginx/php: đúng op, If-Match lệch → 412, header/redirect độc → 422; thêm + gỡ domain áp lại vhost', function () {
    $agent = w5agent();
    $a = new Actors($this);
    w5php($a);
    $sa = $a->spa('SA');
    $id = w5create($sa, $a, 'admin', 'anphat.vn')->json('resource.uuid');
    $agent->calls = [];

    $etag = $sa->get("/api/v1/admin/websites/$id")->headers->get('ETag');
    $u = w5($sa, 'PATCH', "/api/v1/admin/websites/$id", ['document_root' => 'public/web'], ['If-Match' => $etag]);
    assertMatchesContract(W5A, 'patch', '/api/v1/admin/websites/{id}', 202, $u);
    // Không đổi PHP → chỉ áp lại vhost.
    expect($agent->ops())->toBe(['nginx.vhost.apply'])->and($agent->calls[0]['params']['document_root'])->toBe('public/web');
    $stale = w5($sa, 'PATCH', "/api/v1/admin/websites/$id", ['document_root' => 'public'], ['If-Match' => $etag]);
    assertMatchesContract(W5A, 'patch', '/api/v1/admin/websites/{id}', 412, $stale);

    $agent->calls = [];
    $ng = w5($sa, 'PATCH', "/api/v1/admin/websites/$id/nginx", ['client_max_body_size' => '128m', 'hsts' => true,
        'extra_headers' => ['X-Frame-Options' => 'DENY'], 'redirects' => [['from' => '/cu', 'to' => 'https://anphat.vn/moi', 'code' => 301]]]);
    assertMatchesContract(W5A, 'patch', '/api/v1/admin/websites/{id}/nginx', 202, $ng);
    expect($agent->calls[0]['params'])->toMatchArray(['client_max_body_size' => '128m',
        'extra_headers' => ['X-Frame-Options' => 'DENY'], 'redirects' => [['from' => '/cu', 'to' => 'https://anphat.vn/moi', 'code' => 301]]]);
    $n = $sa->get("/api/v1/admin/websites/$id/nginx");
    assertMatchesContract(W5A, 'get', '/api/v1/admin/websites/{id}/nginx', 200, $n);
    expect($n->json('data'))->toMatchArray(['client_max_body_size' => '128m', 'hsts' => true, 'extra_headers' => ['X-Frame-Options' => 'DENY']]);
    foreach ([['extra_headers' => ['X-A' => 'a; add_header B b']], ['extra_headers' => ['X-A' => "a\nb"]],
        ['redirects' => [['from' => '/a', 'to' => 'javascript:alert(1)', 'code' => 301]]],
        ['redirects' => [['from' => 'a b', 'to' => 'https://x.vn', 'code' => 301]]], ['client_max_body_size' => '1t']] as $bad) {
        $r = w5($sa, 'PATCH', "/api/v1/admin/websites/$id/nginx", $bad);
        expect($r->status())->toBe(422, json_encode($bad));
    }

    $agent->calls = [];
    $over = w5($sa, 'PATCH', "/api/v1/admin/websites/$id/php", ['pm_max_children' => 8]); // gói cho 4 worker
    assertMatchesContract(W5A, 'patch', '/api/v1/admin/websites/{id}/php', 422, $over);
    expect($over->json('code'))->toBe('quota_exceeded')->and($agent->calls)->toBe([]);
    $p = w5($sa, 'PATCH', "/api/v1/admin/websites/$id/php", ['memory_limit' => '512m', 'pm_max_children' => 3,
        'disable_functions' => ['exec', 'system']]);
    assertMatchesContract(W5A, 'patch', '/api/v1/admin/websites/{id}/php', 202, $p);
    expect($agent->ops())->toBe(['php.pool.apply'])->and($agent->calls[0]['params'])->toMatchArray(['memory_limit' => '512m',
        'pm_max_children' => 3, 'disable_functions' => ['exec', 'system']]);
    expect(w5($sa, 'PATCH', "/api/v1/admin/websites/$id/php", ['disable_functions' => ['exec;rm']])->status())->toBe(422)
        ->and(w5($sa, 'PATCH', "/api/v1/admin/websites/$id/php", ['pm_max_children' => 500])->status())->toBe(422);

    $agent->calls = [];
    w5($sa, 'POST', "/api/v1/admin/websites/$id/domains", ['name' => 'www.anphat.vn', 'type' => 'alias'])->assertStatus(202);
    w5($sa, 'POST', "/api/v1/admin/websites/$id/domains", ['name' => 'anphat.com', 'type' => 'redirect'])->assertStatus(202);
    expect($agent->ops())->toBe(['nginx.vhost.apply', 'nginx.vhost.apply'])
        ->and($agent->calls[1]['params'])->toMatchArray(['server_names' => ['anphat.vn', 'www.anphat.vn'], 'redirect_names' => ['anphat.com']]);
    $dom = WebsiteDomain::query()->where('name', 'www.anphat.vn')->firstOrFail();
    $rm = w5($sa, 'DELETE', "/api/v1/admin/websites/$id/domains/{$dom->uuid}");
    assertMatchesContract(W5A, 'delete', '/api/v1/admin/websites/{id}/domains/{domain}', 202, $rm);
    expect(collect($agent->calls)->last()['params']['server_names'])->toBe(['anphat.vn'])
        ->and(WebsiteDomain::query()->where('name', 'www.anphat.vn')->exists())->toBeFalse();
    $primary = WebsiteDomain::query()->where('name', 'anphat.vn')->firstOrFail();
    expect(w5($sa, 'DELETE', "/api/v1/admin/websites/$id/domains/{$primary->uuid}")->status())->toBe(409);
});

it('nginx -t lỗi khi tạo → website failed + thông báo; lỗi khi thêm domain → domain gỡ khỏi desired state, site vẫn ready', function () {
    $fail = 'nginx-test-fail.vn';
    w5agent(['nginx.vhost.apply' => function (array $env) use (&$fail): array {
        return in_array($fail, $env['params']['server_names'], true)
            ? ['__error' => ['config_test_failed', 'nginx: [emerg] invalid parameter', false]] : ['ok' => true];
    }]);
    $a = new Actors($this);
    w5php($a);
    $sa = $a->spa('SA');

    $r = w5create($sa, $a, 'admin', $fail);
    $r->assertStatus(202);
    $w = Website::query()->where('uuid', $r->json('resource.uuid'))->firstOrFail();
    expect($w->status)->toBe('failed')->and($w->drift['apply'] ?? '')->toContain('emerg')
        ->and(Job::query()->where('uuid', $r->json('job.uuid'))->value('state'))->toBe('failed')
        ->and(Notification::query()->where('user_id', $a->sa->id)->where('type', 'job.failed')->exists())->toBeTrue();

    $ok = w5create($sa, $a, 'admin', 'anphat.vn')->json('resource.uuid');
    $fail = 'www.anphat.vn';
    w5($sa, 'POST', "/api/v1/admin/websites/$ok/domains", ['name' => 'www.anphat.vn', 'type' => 'alias'])->assertStatus(202);
    $site = Website::query()->where('uuid', $ok)->firstOrFail();
    expect($site->status)->toBe('ready')->and($site->spec_version)->toBe($site->observed_version)
        ->and(WebsiteDomain::withTrashed()->where('name', 'www.anphat.vn')->exists())->toBeFalse();
});

it('suspend account áp lại vhost (trang tạm khóa) cho mọi website; unsuspend trả lại; xóa website: vhost.remove → pool.remove', function () {
    $agent = w5agent();
    $a = new Actors($this);
    w5php($a);
    $sa = $a->spa('SA');
    $id = w5create($sa, $a, 'admin', 'anphat.vn')->json('resource.uuid');
    w5create($sa, $a, 'admin', 'tinh.vn', ['type' => 'static', 'php_version' => null])->assertStatus(202);
    $u = "/api/v1/admin/hosting-accounts/{$a->account->uuid}";

    $agent->calls = [];
    w5($sa, 'POST', "$u:suspend", ['reason' => 'Quá hạn'])->assertStatus(202);
    $vh = collect($agent->calls)->where('op', 'nginx.vhost.apply')->values();
    expect($vh)->toHaveCount(2)->and($vh->pluck('params.suspended')->all())->toBe([true, true])
        ->and(Website::query()->pluck('status')->unique()->all())->toBe(['suspended']);
    // Account khóa vẫn sửa được cấu hình, nhưng vhost áp xuống vẫn là trang tạm khóa.
    $agent->calls = [];
    w5($sa, 'PATCH', "/api/v1/admin/websites/$id", ['document_root' => 'public/x'])->assertStatus(202);
    expect($agent->calls[0]['params'])->toMatchArray(['suspended' => true, 'document_root' => 'public/x'])
        ->and(Website::query()->where('uuid', $id)->value('status'))->toBe('suspended');

    $agent->calls = [];
    w5($sa, 'POST', "$u:unsuspend")->assertStatus(202);
    expect(collect($agent->calls)->where('op', 'nginx.vhost.apply')->pluck('params.suspended')->all())->toBe([false, false])
        ->and(Website::query()->pluck('status')->unique()->all())->toBe(['ready']);

    $agent->calls = [];
    $del = w5($sa, 'DELETE', "/api/v1/admin/websites/$id");
    assertMatchesContract(W5A, 'delete', '/api/v1/admin/websites/{id}', 202, $del);
    expect($agent->ops())->toBe(['nginx.vhost.remove', 'php.pool.remove'])
        ->and(Website::query()->where('uuid', $id)->exists())->toBeFalse()
        ->and(Website::withTrashed()->where('uuid', $id)->exists())->toBeTrue();
    expect($sa->get("/api/v1/admin/websites/$id")->status())->toBe(404);
    // Job của website đã xóa vẫn đọc được.
    assertMatchesContract(W5A, 'get', '/api/v1/admin/jobs/{id}', 200, $sa->get('/api/v1/admin/jobs/'.$del->json('job.uuid')));
});

it('ma trận quyền: ADMIN ngoài phạm vi/USER khác → 404; PHP Manager/Nginx toàn server cần software.write/servers.write', function () {
    w5agent();
    $a = new Actors($this);
    w5php($a);
    $id = w5create($a->spa('SA'), $a, 'admin', 'anphat.vn')->json('resource.uuid');

    expect($a->spa('AD_IN')->get("/api/v1/admin/websites/$id")->status())->toBe(200);
    $out = $a->spa('AD_OUT');
    assertMatchesContract(W5A, 'get', '/api/v1/admin/websites/{id}', 404, $out->get("/api/v1/admin/websites/$id"));
    expect($out->get('/api/v1/admin/websites')->json('data'))->toBe([])
        ->and(w5create($out, $a, 'admin', 'x.vn')->status())->toBe(422)
        ->and(w5($out, 'PATCH', "/api/v1/admin/websites/$id/php", ['pm_max_children' => 2])->status())->toBe(404);

    $other = $a->spa('US_OTHER');
    assertMatchesContract(W5P, 'get', '/api/v1/portal/websites/{id}', 404, $other->get("/api/v1/portal/websites/$id"));
    expect($other->get('/api/v1/portal/websites')->json('data'))->toBe([])
        ->and(w5($other, 'DELETE', "/api/v1/portal/websites/$id")->status())->toBeIn([403, 404])
        ->and(w5create($other, $a, 'portal', 'y.vn')->status())->toBe(422)
        ->and($a->spa('US_OWNER')->get('/api/v1/admin/websites')->status())->toBeIn([401, 403]);

    $sid = $a->server->uuid;
    $in = $a->spa('AD_IN');
    expect($in->get("/api/v1/admin/servers/$sid/php-versions")->status())->toBe(200)
        ->and(w5($in, 'POST', "/api/v1/admin/servers/$sid/php-versions/8.3:install")->status())->toBe(403)
        ->and(w5($in, 'PATCH', "/api/v1/admin/servers/$sid/nginx", ['gzip' => false])->status())->toBe(403)
        ->and($out->get("/api/v1/admin/servers/$sid/nginx")->status())->toBe(404);
});

it('PHP Manager: liệt kê, cài 8.3 qua job, bản ngoài catalog 409, gỡ khi còn site 409, thêm extension; Nginx toàn server', function () {
    $agent = w5agent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $sid = $a->server->uuid;

    $l = $sa->get("/api/v1/admin/servers/$sid/php-versions");
    assertMatchesContract(W5A, 'get', '/api/v1/admin/servers/{id}/php-versions', 200, $l);
    expect(collect($l->json('data'))->pluck('version')->all())->toBe(['8.1', '8.2', '8.3', '8.4']) // 8.1/8.2/8.4 qua PPA (D-100)
        ->and(collect($l->json('data'))->firstWhere('version', '8.3'))->toMatchArray(['version' => '8.3', 'installed' => false, 'default' => true]);
    $ext0 = w5($sa, 'POST', "/api/v1/admin/servers/$sid/php-versions/8.3/extensions", ['extensions' => ['gd']]);
    assertMatchesContract(W5A, 'post', '/api/v1/admin/servers/{id}/php-versions/{version}/extensions', 409, $ext0);

    $i = w5($sa, 'POST', "/api/v1/admin/servers/$sid/php-versions/8.3:install");
    assertMatchesContract(W5A, 'post', '/api/v1/admin/servers/{id}/php-versions/{version}:{action}', 202, $i);
    expect($agent->ops())->toBe(['php.version.install'])
        ->and(PhpVersion::query()->where('server_id', $a->server->id)->value('status'))->toBe('ready');
    $old = w5($sa, 'POST', "/api/v1/admin/servers/$sid/php-versions/7.4:install");
    assertMatchesContract(W5A, 'post', '/api/v1/admin/servers/{id}/php-versions/{version}:{action}', 409, $old);
    expect(w5($sa, 'POST', "/api/v1/admin/servers/$sid/php-versions/8.3:upgrade")->status())->toBe(422);

    $agent->calls = [];
    $e = w5($sa, 'POST', "/api/v1/admin/servers/$sid/php-versions/8.3/extensions", ['extensions' => ['gd', 'redis']]);
    assertMatchesContract(W5A, 'post', '/api/v1/admin/servers/{id}/php-versions/{version}/extensions', 202, $e);
    expect($agent->calls[0]['params'])->toBe(['version' => '8.3', 'extensions' => ['gd', 'redis']])
        ->and($sa->get("/api/v1/admin/servers/$sid/php-versions")->json('data.2.extensions'))->toContain('gd', 'redis', 'intl');
    expect(w5($sa, 'POST', "/api/v1/admin/servers/$sid/php-versions/8.3/extensions", ['extensions' => ['evil;rm']])->status())->toBe(422);

    w5create($sa, $a, 'admin', 'anphat.vn')->assertStatus(202);
    $rm = w5($sa, 'POST', "/api/v1/admin/servers/$sid/php-versions/8.3:remove");
    assertMatchesContract(W5A, 'post', '/api/v1/admin/servers/{id}/php-versions/{version}:{action}', 409, $rm);
    expect($rm->json('code'))->toBe('resource_locked')
        ->and($sa->get("/api/v1/admin/servers/$sid/php-versions")->json('data.2.sites_count'))->toBe(1);

    $g = $sa->get("/api/v1/admin/servers/$sid/nginx");
    assertMatchesContract(W5A, 'get', '/api/v1/admin/servers/{id}/nginx', 200, $g);
    expect($g->json('data'))->toMatchArray(['worker_processes' => 'auto', 'worker_connections' => 1024, 'server_tokens' => false]);
    $agent->calls = [];
    $p = w5($sa, 'PATCH', "/api/v1/admin/servers/$sid/nginx", ['worker_connections' => 4096, 'gzip' => false],
        ['If-Match' => $g->headers->get('ETag')]);
    assertMatchesContract(W5A, 'patch', '/api/v1/admin/servers/{id}/nginx', 202, $p);
    expect($agent->ops())->toBe(['nginx.global.apply'])->and($agent->calls[0]['params'])->toMatchArray(['worker_connections' => 4096, 'gzip' => false])
        ->and($sa->get("/api/v1/admin/servers/$sid/nginx")->json('data.worker_connections'))->toBe(4096);
    expect(w5($sa, 'PATCH', "/api/v1/admin/servers/$sid/nginx", ['gzip' => true], ['If-Match' => $g->headers->get('ETag')])->status())->toBe(412)
        ->and(w5($sa, 'PATCH', "/api/v1/admin/servers/$sid/nginx", ['worker_connections' => 4096])->status())->toBe(409)
        ->and(w5($sa, 'PATCH', "/api/v1/admin/servers/$sid/nginx", ['worker_processes' => '999'])->status())->toBe(422)
        ->and(w5($sa, 'PATCH', "/api/v1/admin/servers/$sid/nginx", ['worker_connections' => 10])->status())->toBe(422);
});

it('log agent không kết nối → 503 agent_unavailable', function () {
    w5agent(['log.tail' => fn () => ['__error' => ['internal', 'không đọc được', false]]]);
    $a = new Actors($this);
    w5php($a);
    $sa = $a->spa('SA');
    $id = w5create($sa, $a, 'admin', 'anphat.vn')->json('resource.uuid');
    $r = $sa->get("/api/v1/admin/websites/$id/logs?kind=error");
    assertMatchesContract(W5A, 'get', '/api/v1/admin/websites/{id}/logs', 503, $r);
});

it('wizard bước 4: xem web stack, cài phần còn thiếu qua job setup.stack; đủ → steps_done có stack', function () {
    $agent = w5agent(['software.install' => fn (array $env) => ['installed' => true,
        'version' => $env['params']['recipe'] === 'nginx' ? '1.24.0' : '4.9.1']]);
    $a = new Actors($this);
    config(['itso.local_server.name' => $a->server->name]);
    // SA do wizard tạo, đã bật TOTP.
    $raw = strtoupper(strtr(Str::random(12), ['I' => 'J', 'O' => 'P', '0' => '2', '1' => '3', 'i' => 'j', 'o' => 'p', 'l' => 'm']));
    $file = sys_get_temp_dir().'/itso-setup-'.Str::random(8).'.json';
    file_put_contents($file, json_encode(['sha256' => hash('sha256', $raw), 'created_at' => now()->utc()->toIso8601String(),
        'expires_at' => now()->addHour()->utc()->toIso8601String()]));
    config(['itso.setup_code_file' => $file]);
    // Panel chưa có SUPER_ADMIN nào ngoài người wizard sắp tạo.
    DB::table('user_roles')->where('user_id', $a->sa->id)->delete();
    $spa = $this->spa('admin');
    $spa->get('/api/v1/auth/csrf')->assertNoContent();
    $spa->call('POST', '/api/v1/admin/setup/code:verify', ['code' => substr($raw, 0, 4).'-'.substr($raw, 4, 4).'-'.substr($raw, 8, 4)])->assertOk();
    $spa->post('/api/v1/admin/setup/admin', ['name' => 'Quản trị', 'email' => 'root@itso.local', 'password' => 'mat-khau-rat-dai-2026'])
        ->assertCreated();
    $secret = (string) $spa->post('/api/v1/auth/mfa/totp:enroll')->json('data.secret');
    $spa->post('/api/v1/auth/mfa/totp:confirm', ['code' => Totp::at($secret, now()->getTimestamp()), 'method' => 'totp'])->assertNoContent();

    $st = $spa->get('/api/v1/admin/setup/stack');
    assertMatchesContract(W5A, 'get', '/api/v1/admin/setup/stack', 200, $st);
    expect(collect($st->json('data.components'))->pluck('state', 'key')->all())
        ->toBe(['nginx' => 'available', 'php8.3' => 'available', 'lego' => 'available'])->and($st->json('data.ready'))->toBeFalse();

    $i = w5($spa, 'POST', '/api/v1/admin/setup/stack:install');
    assertMatchesContract(W5A, 'post', '/api/v1/admin/setup/stack:install', 202, $i);
    expect($i->json('job.type'))->toBe('setup.stack')
        ->and($agent->ops())->toBe(['software.install', 'php.version.install', 'software.install'])
        ->and(ServerSoftware::query()->where('server_id', $a->server->id)->pluck('version', 'software_key')->all())
        ->toMatchArray(['nginx' => '1.24.0', 'lego' => '4.9.1']);
    $done = $spa->get('/api/v1/admin/setup/stack');
    expect($done->json('data.ready'))->toBeTrue()->and($done->json('data.job_uuid'))->toBeNull()
        ->and($spa->get('/api/v1/admin/setup/status')->json('data.steps_done'))->toContain('stack');
    $again = w5($spa, 'POST', '/api/v1/admin/setup/stack:install');
    assertMatchesContract(W5A, 'post', '/api/v1/admin/setup/stack:install', 409, $again);
});
