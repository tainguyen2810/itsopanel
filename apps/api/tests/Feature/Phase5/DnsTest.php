<?php

use App\Models\DnsProvider;
use App\Models\DnsRecord;
use App\Models\DnsZone;
use App\Models\Job;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\Spa;

// Prompt 5.4: DNS Cloudflare qua Http::fake — ghi Cloudflare trước, lỗi 4xx/5xx không đổi DB, token không lộ.

const D5 = 'itso-admin-v1.yaml';
const CF = 'https://api.cloudflare.com/client/v4';
const TOKEN = 'cf_TokenBiMat_0123456789abcdefXYZ';
const ZID = '0123456789abcdef0123456789abcdef';

function d5(Spa $spa, string $method, string $uri, array $body = [], array $h = []): TestResponse
{
    return $spa->call($method, $uri, $body, $h + ['Idempotency-Key' => (string) Str::uuid()]);
}

/** Cloudflare giả: lưu record trong bộ nhớ; `$fail` ép mã lỗi cho lệnh ghi kế tiếp. */
final class FakeCloudflare
{
    /** @var array<string, array<string, mixed>> */
    public array $records = [];

    public ?int $fail = null;

    public ?int $verify = null;

    /** @var list<Request> */
    public array $requests = [];

    public function __construct()
    {
        $this->records['r1'] = ['id' => 'r1', 'type' => 'A', 'name' => 'anphat.vn', 'content' => '203.0.113.10', 'ttl' => 1, 'proxied' => false];
        $this->records['r2'] = ['id' => 'r2', 'type' => 'MX', 'name' => 'anphat.vn', 'content' => 'mx.anphat.vn', 'ttl' => 3600, 'priority' => 10, 'proxied' => false];
        $this->records['r3'] = ['id' => 'r3', 'type' => 'HTTPS', 'name' => 'anphat.vn', 'content' => '1 .', 'ttl' => 300, 'proxied' => false];
        Http::fake(['api.cloudflare.com/*' => fn (Request $r) => $this->handle($r)]);
    }

    private function handle(Request $r): mixed
    {
        $this->requests[] = $r;
        $path = substr(parse_url($r->url(), PHP_URL_PATH), strlen('/client/v4'));
        if ($r->header('Authorization')[0] !== 'Bearer '.TOKEN) {
            return Http::response(['success' => false, 'errors' => [['code' => 1000, 'message' => 'Invalid API Token']]], 401);
        }
        if ($path === '/user/tokens/verify') {
            return $this->verify !== null ? Http::response(['success' => false, 'errors' => [['code' => 0, 'message' => 'boom']]], $this->verify)
                : self::ok(['id' => 't', 'status' => 'active']);
        }
        if ($path === '/accounts') {
            return self::ok([['id' => 'a', 'name' => 'ITSO Cloudflare']]);
        }
        if ($path === '/zones') {
            parse_str((string) parse_url($r->url(), PHP_URL_QUERY), $q);

            return self::ok(($q['name'] ?? '') === 'anphat.vn' ? [['id' => ZID, 'name' => 'anphat.vn']] : []);
        }
        if ($this->fail !== null && $r->method() !== 'GET') {
            return Http::response(['success' => false, 'errors' => [['code' => 81057, 'message' => 'Record already exists.']]], $this->fail);
        }
        if ($path === '/zones/'.ZID.'/dns_records') {
            if ($r->method() === 'GET') {
                return self::ok(array_values($this->records));
            }
            $id = 'n'.count($this->records);
            $this->records[$id] = ['id' => $id] + $r->data();

            return self::ok($this->records[$id]);
        }
        if (preg_match('#^/zones/'.ZID.'/dns_records/(\w+)$#', $path, $m)) {
            if ($r->method() === 'DELETE') {
                unset($this->records[$m[1]]);

                return self::ok(['id' => $m[1]]);
            }
            $this->records[$m[1]] = array_merge($this->records[$m[1]], $r->data());

            return self::ok($this->records[$m[1]]);
        }

        return Http::response(['success' => false, 'errors' => [['code' => 7003, 'message' => 'No route']]], 404);
    }

    private static function ok(mixed $result): mixed
    {
        return Http::response(['success' => true, 'errors' => [], 'result' => $result]);
    }
}

it('provider: token sai → 422, Cloudflare 5xx → 409, DB không đổi; tạo đúng → 201, token mã hóa, không trả về', function () {
    $cf = new FakeCloudflare;
    $a = new Actors($this);
    $sa = $a->spa('SA');

    $bad = $sa->post('/api/v1/admin/dns/providers', ['type' => 'cloudflare', 'name' => 'CF', 'api_token' => 'cf_SaiToken_0123456789abcdef']);
    assertMatchesContract(D5, 'post', '/api/v1/admin/dns/providers', 422, $bad);
    expect($bad->json('errors'))->toHaveKey('api_token');
    $cf->verify = 503;
    expect($sa->post('/api/v1/admin/dns/providers', ['type' => 'cloudflare', 'name' => 'CF', 'api_token' => TOKEN])->status())->toBe(409)
        ->and(DnsProvider::query()->count())->toBe(0);
    $cf->verify = null;
    $unk = $sa->post('/api/v1/admin/dns/providers', ['type' => 'cloudflare', 'name' => 'CF', 'api_token' => TOKEN, 'base_url' => 'https://evil']);
    expect($unk->status())->toBe(422);

    $ok = $sa->post('/api/v1/admin/dns/providers', ['type' => 'cloudflare', 'name' => 'Cloudflare chính', 'api_token' => TOKEN]);
    assertMatchesContract(D5, 'post', '/api/v1/admin/dns/providers', 201, $ok);
    expect($ok->json('data'))->toMatchArray(['account_label' => 'ITSO Cloudflare', 'zones_count' => 0])
        ->and($ok->getContent())->not->toContain(TOKEN);
    assertMatchesContract(D5, 'get', '/api/v1/admin/dns/providers', 200, $sa->get('/api/v1/admin/dns/providers'));
    foreach (['dns_providers', 'audit_logs', 'job_steps', 'job_logs'] as $t) {
        expect(DB::table($t)->get()->contains(fn ($row) => str_contains(json_encode($row), TOKEN)))->toBeFalse("token lộ trong $t");
    }
    expect(collect($cf->requests)->every(fn (Request $r) => str_starts_with($r->url(), CF.'/')))->toBeTrue();

    // Quyền: ADMIN không thêm provider; xóa cần step-up (SA đã step-up), còn zone → 409.
    expect($a->spa('AD_IN')->post('/api/v1/admin/dns/providers', ['type' => 'cloudflare', 'name' => 'X', 'api_token' => TOKEN])->status())->toBe(403);
    $pid = $ok->json('data.uuid');
    $sa->post('/api/v1/admin/dns/zones', ['provider_uuid' => $pid, 'name' => 'anphat.vn'])->assertCreated();
    assertMatchesContract(D5, 'delete', '/api/v1/admin/dns/providers/{id}', 409, $sa->delete("/api/v1/admin/dns/providers/$pid"));
});

it('zone: không có trên Cloudflare → 422; tạo → đồng bộ record (bỏ loại chưa hỗ trợ); ADMIN chỉ zone của account trong phạm vi', function () {
    new FakeCloudflare;
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $pid = $sa->post('/api/v1/admin/dns/providers', ['type' => 'cloudflare', 'name' => 'CF', 'api_token' => TOKEN])->json('data.uuid');

    $none = $sa->post('/api/v1/admin/dns/zones', ['provider_uuid' => $pid, 'name' => 'khong-co.vn']);
    assertMatchesContract(D5, 'post', '/api/v1/admin/dns/zones', 422, $none);
    $in = $a->spa('AD_IN');
    expect($in->post('/api/v1/admin/dns/zones', ['provider_uuid' => $pid, 'name' => 'anphat.vn'])->status())->toBe(422); // không gắn account
    $z = $in->post('/api/v1/admin/dns/zones', ['provider_uuid' => $pid, 'name' => 'anphat.vn', 'hosting_account_uuid' => $a->account->uuid]);
    assertMatchesContract(D5, 'post', '/api/v1/admin/dns/zones', 201, $z);
    expect($z->json('data'))->toMatchArray(['provider' => 'cloudflare', 'records_count' => 2])
        ->and($z->json('data.hosting_account.uuid'))->toBe($a->account->uuid);
    $zid = $z->json('data.uuid');
    assertMatchesContract(D5, 'post', '/api/v1/admin/dns/zones', 409,
        $sa->post('/api/v1/admin/dns/zones', ['provider_uuid' => $pid, 'name' => 'anphat.vn']));

    $recs = $in->get("/api/v1/admin/dns/zones/$zid/records");
    assertMatchesContract(D5, 'get', '/api/v1/admin/dns/zones/{id}/records', 200, $recs);
    expect(collect($recs->json('data'))->map(fn ($r) => [$r['type'], $r['name'], $r['ttl']])->sortBy(0)->values()->all())
        ->toBe([['A', '@', 300], ['MX', '@', 3600]]);
    assertMatchesContract(D5, 'get', '/api/v1/admin/dns/zones', 200, $in->get('/api/v1/admin/dns/zones'));

    $out = $a->spa('AD_OUT');
    expect($out->get('/api/v1/admin/dns/zones')->json('data'))->toBe([])
        ->and($out->get("/api/v1/admin/dns/zones/$zid/records")->status())->toBe(404)
        ->and($a->spa('US_OWNER')->get('/api/v1/portal/dns/zones')->status())->toBe(404);

    // Đổi account gắn zone: If-Match sai → 412; ADMIN không bỏ gắn → 422.
    $p = $sa->call('PATCH', "/api/v1/admin/dns/zones/$zid", ['hosting_account_uuid' => null], ['If-Match' => '"dz-sai"']);
    assertMatchesContract(D5, 'patch', '/api/v1/admin/dns/zones/{id}', 412, $p);
    expect($in->call('PATCH', "/api/v1/admin/dns/zones/$zid", ['hosting_account_uuid' => null])->status())->toBe(422);
    $p2 = $sa->call('PATCH', "/api/v1/admin/dns/zones/$zid", ['hosting_account_uuid' => null]);
    assertMatchesContract(D5, 'patch', '/api/v1/admin/dns/zones/{id}', 200, $p2);
    expect($in->get('/api/v1/admin/dns/zones')->json('data'))->toBe([]);
});

it('record: tạo/sửa/xóa ghi Cloudflare trước rồi mới lưu DB; Cloudflare 4xx → job failed, DB giữ nguyên; 5xx → thử lại rồi failed', function () {
    $cf = new FakeCloudflare;
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $pid = $sa->post('/api/v1/admin/dns/providers', ['type' => 'cloudflare', 'name' => 'CF', 'api_token' => TOKEN])->json('data.uuid');
    $zid = $sa->post('/api/v1/admin/dns/zones', ['provider_uuid' => $pid, 'name' => 'anphat.vn'])->json('data.uuid');
    $u = "/api/v1/admin/dns/zones/$zid/records";

    $c = d5($sa, 'POST', $u, ['type' => 'A', 'name' => 'www', 'content' => '203.0.113.20', 'ttl' => 300, 'proxied' => true]);
    assertMatchesContract(D5, 'post', '/api/v1/admin/dns/zones/{id}/records', 202, $c);
    expect($c->json('job'))->toMatchArray(['type' => 'dns.record.create', 'state' => 'succeeded'])
        ->and($c->json('job.steps.0.op'))->toBe('dns.records.apply')->and($c->json('job.server'))->toBeNull();
    $row = DnsRecord::query()->where('name', 'www')->firstOrFail();
    expect($row)->external_id->toBe('n3')->proxied->toBeTrue()
        ->and($cf->records['n3'])->toMatchArray(['name' => 'www.anphat.vn', 'content' => '203.0.113.20', 'proxied' => true]);

    foreach ([['type' => 'A', 'name' => 'x', 'content' => '999.1.1.1', 'ttl' => 300], ['type' => 'MX', 'name' => '@', 'content' => 'mx2.anphat.vn', 'ttl' => 300],
        ['type' => 'TXT', 'name' => 'a b', 'content' => 'v', 'ttl' => 300], ['type' => 'A', 'name' => 'x', 'content' => '1.1.1.1', 'ttl' => 5],
        ['type' => 'TXT', 'name' => 'x', 'content' => 'v', 'ttl' => 300, 'proxied' => true], ['type' => 'CAA', 'name' => '@', 'content' => 'issue letsencrypt', 'ttl' => 300],
        ['type' => 'TXT', 'name' => 'x', 'content' => "a\nb", 'ttl' => 300]] as $bad) {
        expect(d5($sa, 'POST', $u, $bad)->status())->toBe(422, json_encode($bad));
    }

    $before = DnsRecord::query()->count();
    $cf->fail = 400;
    $f = d5($sa, 'POST', $u, ['type' => 'TXT', 'name' => '_dmarc', 'content' => 'v=DMARC1; p=none', 'ttl' => 300]);
    expect($f->json('job.state'))->toBe('failed')->and($f->json('job.error.code'))->toBe('invalid_params')
        ->and($f->json('job.error.message'))->toContain('Record already exists')
        ->and(DnsRecord::query()->count())->toBe($before);
    $cf->fail = 502;
    $f5 = d5($sa, 'POST', $u, ['type' => 'TXT', 'name' => '_dmarc', 'content' => 'v=DMARC1; p=none', 'ttl' => 300]);
    $job = Job::query()->where('uuid', $f5->json('job.uuid'))->firstOrFail();
    expect($job->state)->toBe('failed')->and($job->attempts)->toBe(3)->and($job->error_code)->toBe('dependency_unavailable')
        ->and(DnsRecord::query()->count())->toBe($before);
    // Sửa lỗi 4xx: bản ghi trong DB giữ nội dung cũ.
    $cf->fail = 400;
    d5($sa, 'PATCH', "$u/{$row->uuid}", ['content' => '203.0.113.99']);
    expect($row->refresh()->content)->toBe('203.0.113.20');
    $cf->fail = null;

    $up = d5($sa, 'PATCH', "$u/{$row->uuid}", ['content' => '203.0.113.21', 'proxied' => false]);
    assertMatchesContract(D5, 'patch', '/api/v1/admin/dns/zones/{id}/records/{record}', 202, $up);
    expect($row->refresh())->content->toBe('203.0.113.21')->proxied->toBeFalse()
        ->and($cf->records['n3']['content'])->toBe('203.0.113.21');
    expect(d5($sa, 'PATCH', "$u/{$row->uuid}", ['content' => '203.0.113.21'])->status())->toBe(409);

    $del = d5($sa, 'DELETE', "$u/{$row->uuid}");
    assertMatchesContract(D5, 'delete', '/api/v1/admin/dns/zones/{id}/records/{record}', 202, $del);
    expect(DnsRecord::query()->whereKey($row->id)->exists())->toBeFalse()->and($cf->records)->not->toHaveKey('n3');
    // ADMIN ngoài phạm vi không ghi được record.
    expect(d5($a->spa('AD_OUT'), 'POST', $u, ['type' => 'A', 'name' => 'y', 'content' => '1.1.1.1', 'ttl' => 300])->status())->toBe(404);
});

it('đồng bộ: :sync và itso:dns-sync lấy lại record từ Cloudflare; gỡ zone không đụng Cloudflare', function () {
    $cf = new FakeCloudflare;
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $pid = $sa->post('/api/v1/admin/dns/providers', ['type' => 'cloudflare', 'name' => 'CF', 'api_token' => TOKEN])->json('data.uuid');
    $zid = $sa->post('/api/v1/admin/dns/zones', ['provider_uuid' => $pid, 'name' => 'anphat.vn'])->json('data.uuid');

    $cf->records['r9'] = ['id' => 'r9', 'type' => 'CNAME', 'name' => 'blog.anphat.vn', 'content' => 'anphat.vn', 'ttl' => 600, 'proxied' => true];
    unset($cf->records['r2']);
    $s = $sa->post("/api/v1/admin/dns/zones/$zid:sync");
    assertMatchesContract(D5, 'post', '/api/v1/admin/dns/zones/{id}:sync', 200, $s);
    expect($s->json('data.records_count'))->toBe(2)
        ->and(DnsRecord::query()->pluck('name', 'type')->all())->toMatchArray(['A' => '@', 'CNAME' => 'blog']);

    $cf->records['r10'] = ['id' => 'r10', 'type' => 'TXT', 'name' => 'anphat.vn', 'content' => 'v=spf1 -all', 'ttl' => 300, 'proxied' => false];
    $this->artisan('itso:dns-sync')->assertSuccessful();
    expect(DnsRecord::query()->count())->toBe(3);

    $n = count($cf->requests);
    assertMatchesContract(D5, 'delete', '/api/v1/admin/dns/zones/{id}', 204, $sa->delete("/api/v1/admin/dns/zones/$zid"));
    expect(count($cf->requests))->toBe($n)->and(DnsZone::query()->count())->toBe(0)->and(DnsRecord::query()->count())->toBe(0)
        ->and($cf->records)->toHaveKey('r10');
    assertMatchesContract(D5, 'delete', '/api/v1/admin/dns/providers/{id}', 204, $sa->delete("/api/v1/admin/dns/providers/$pid"));
});
