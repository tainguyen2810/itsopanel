<?php

use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobRunner;
use App\Domain\Jobs\JobSpec;
use App\Domain\Servers\CertRotation;
use App\Http\Controllers\Api\V1\Internal\NodeEnrollController;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Jobs\RunJob;
use App\Models\Agent;
use App\Models\AgentCertificate;
use App\Models\AgentEnrollmentToken;
use App\Models\AuditLog;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\Job;
use App\Models\Notification;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;

// Prompt 9.4: token join, enroll qua relay, thu hồi, đồng bộ relay, job chờ node (D-91), xoay chứng chỉ, gợi ý server.

const P9 = 'itso-admin-v1.yaml';
const P9_CA = "-----BEGIN CERTIFICATE-----\nMIIBUzCB+qADAgECAgEBMAoGCCqGSM49BAMCMBkxFzAVBgNVBAMTDklUU08gdGVzdCBDQTAeFw0yNjExMjEwMDAwMDBaFw0zNjExMjEwMDAwMDBaMBkxFzAVBgNVBAMTDklUU08gdGVzdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABA==\n-----END CERTIFICATE-----\n";
const P9_RELAY_KEY = 'relay-enroll-key-for-tests-0123456789abcdef';
const P9_CSR = "-----BEGIN CERTIFICATE REQUEST-----\nMIHVMH0CAQAwFjEUMBIGA1UEAxMLaXRzby1lbnJvbGwwWTATBgcqhkjOPQIBBggqhkjOPQMBBw==\n-----END CERTIFICATE REQUEST-----\n";

function p9files(): void
{
    $dir = sys_get_temp_dir().'/itso-p9-'.getmypid();
    @mkdir($dir, 0700, true);
    file_put_contents("$dir/ca.pem", P9_CA);
    file_put_contents("$dir/enroll.key", P9_RELAY_KEY."\n");
    config(['itso.pki.ca_file' => "$dir/ca.pem", 'itso.relay.enroll_key_file' => "$dir/enroll.key",
        'itso.relay.socket' => '/tmp/itso-test-relay.sock', 'itso.relay.public_url' => 'https://cp.itso.local:28444']);
}

function p9pin(): string
{
    preg_match('/-----BEGIN CERTIFICATE-----(.+?)-----END/s', P9_CA, $m);

    return hash('sha256', base64_decode(preg_replace('/\s+/', '', $m[1])));
}

/** FakeAgent local: pki.sign_csr cấp chứng chỉ giả (fingerprint/serial duy nhất theo lần gọi). */
function p9agent(array $over = []): FakeAgent
{
    $n = 0;

    return new FakeAgent($over + ['pki.sign_csr' => function (array $env) use (&$n): array {
        $n++;

        return ['cert_pem' => "-----BEGIN CERTIFICATE-----\nMIIB$n\n-----END CERTIFICATE-----\n", 'chain_pem' => P9_CA,
            'serial' => str_pad(dechex(1000 + $n), 16, '0', STR_PAD_LEFT), 'fingerprint_sha256' => hash('sha256', $env['params']['server_uuid'].$n),
            'not_before' => now()->subMinute()->toIso8601String(), 'not_after' => now()->addDays(30)->toIso8601String()];
    }, '*' => fn () => ['ok' => true]]);
}

function p9token(array $over = []): string
{
    $token = 'itso_enr_'.str_repeat('A', 43);
    AgentEnrollmentToken::query()->create(['token_hash' => hash('sha256', $token), 'server_name' => 'srv-node-01',
        'role_tags' => ['web'], 'created_by_user_id' => User::factory()->superAdmin()->create()->id,
        'expires_at' => now()->addHour()] + $over);

    return $token;
}

function p9enroll($t, string $token, array $over = [], ?string $sig = null): TestResponse
{
    $body = json_encode(['token' => $token, 'csr' => P9_CSR, 'hostname' => 'node01.itso.local', 'ip_addresses' => ['203.0.113.21'],
        'facts' => ['os' => 'Ubuntu 24.04.1 LTS', 'kernel' => '6.8.0', 'arch' => 'amd64', 'agent_version' => '0.9.0']] + $over);
    $ts = (string) time();
    $sig ??= hash_hmac('sha256', "relay-enroll\n$ts\n".hash('sha256', $body), P9_RELAY_KEY);

    return $t->call('POST', '/api/v1/internal/nodes:enroll', [], [], [], ['CONTENT_TYPE' => 'application/json',
        'HTTP_ACCEPT' => 'application/json', 'HTTP_X_ITSO_RELAY_TIMESTAMP' => $ts, 'HTTP_X_ITSO_RELAY_SIGNATURE' => $sig,
        'HTTP_X_ITSO_RELAY_CLIENT_IP' => '203.0.113.21'], $body);
}

function p9remote(string $name = 'srv-node-01', string $connection = 'online', ?Carbon $seen = null): Server
{
    $s = Server::factory()->create(['name' => $name, 'node_role' => 'node', 'role_tags' => ['web']]);
    $a = Agent::query()->create(['server_id' => $s->id, 'transport' => 'mtls', 'connection' => $connection,
        'last_seen_at' => $seen ?? now(), 'cert_fingerprint' => hash('sha256', $name), 'cert_not_before' => now()->subDays(25),
        'cert_expires_at' => now()->addDays(5)]);
    DB::table('agents')->where('id', $a->id)->update(['hmac_key_encrypted' => AgentClient::encryptKey(str_repeat('h', 43))]);
    AgentCertificate::query()->create(['server_id' => $s->id, 'serial' => substr(hash('sha256', 's'.$name), 0, 16),
        'fingerprint_sha256' => hash('sha256', $name), 'not_before' => now()->subDays(25), 'not_after' => now()->addDays(5),
        'issued_reason' => 'enroll']);

    return $s;
}

beforeEach(function () {
    p9files();
    RateLimiter::clear('node-enroll:203.0.113.21');
});

it('SUPER_ADMIN + step-up tạo token join một lần (DB chỉ lưu sha256, lệnh ghim CA); ADMIN bị chặn; thiếu CA → 409', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $r = $sa->post('/api/v1/admin/servers/enrollment-tokens', ['name' => 'srv-hn-03', 'role_tags' => ['web'], 'ttl_min' => 30]);
    assertMatchesContract(P9, 'post', '/api/v1/admin/servers/enrollment-tokens', 201, $r);
    $token = (string) $r->json('data.token');
    expect($token)->toMatch('/^itso_enr_[A-Za-z0-9_-]{43}$/')
        ->and($r->json('data.ca_sha256'))->toBe(p9pin())
        ->and($r->json('data.command'))->toContain('--role node --join https://cp.itso.local:28444 --token '.$token.' --ca-sha256 '.p9pin());
    $row = AgentEnrollmentToken::query()->sole();
    expect($row->token_hash)->toBe(hash('sha256', $token))
        ->and(DB::table('agent_enrollment_tokens')->where('token_hash', $token)->exists())->toBeFalse()
        ->and($row->expires_at->diffInMinutes(now(), true))->toBeGreaterThan(29);
    expect(AuditLog::query()->where('action', 'server.enroll')->exists())->toBeTrue();
    $a->spa('AD_IN')->post('/api/v1/admin/servers/enrollment-tokens', ['name' => 'srv-x'])->assertForbidden();
    // Tên trùng → 409; ttl ngoài 5–1440 → 422.
    $sa->post('/api/v1/admin/servers/enrollment-tokens', ['name' => $a->server->name])->assertStatus(409);
    $sa->post('/api/v1/admin/servers/enrollment-tokens', ['name' => 'srv-y', 'ttl_min' => 2])->assertStatus(422);
    config(['itso.pki.ca_file' => '/nonexistent/ca.pem']);
    assertMatchesContract(P9, 'post', '/api/v1/admin/servers/enrollment-tokens', 409,
        $sa->post('/api/v1/admin/servers/enrollment-tokens', ['name' => 'srv-z']));
});

it('enroll qua relay: tạo server node + agent mtls + chứng chỉ + khóa HMAC mã hóa; token dùng lại/hết hạn bị từ chối', function () {
    $agent = p9agent();
    $token = p9token();
    $r = p9enroll($this, $token);
    assertMatchesContract(P9, 'post', '/api/v1/internal/nodes:enroll', 201, $r);
    $s = Server::query()->where('name', 'srv-node-01')->sole();
    expect($s->node_role)->toBe('node')->and($s->hostname)->toBe('node01.itso.local')->and($s->role_tags)->toBe(['web'])
        ->and($r->json('data.server_uuid'))->toBe($s->uuid)->and($r->json('data.ca_sha256'))->toBe(p9pin())
        ->and($r->json('data.relay_url'))->toBe('https://cp.itso.local:28444');
    $call = collect($agent->calls)->firstWhere('op', 'pki.sign_csr');
    expect($call['params'])->toBe(['server_uuid' => $s->uuid, 'csr' => trim(P9_CSR), 'ttl_days' => 30]);
    $ag = Agent::query()->where('server_id', $s->id)->sole();
    expect($ag->transport)->toBe('mtls')->and($ag->connection)->toBe('pending')
        ->and(AgentClient::decryptKey($ag))->toBe($r->json('data.hmac_key'))
        ->and(AgentCertificate::query()->where('server_id', $s->id)->where('issued_reason', 'enroll')->count())->toBe(1);
    $tok = AgentEnrollmentToken::query()->sole();
    expect($tok->used_at)->not->toBeNull()->and($tok->used_by_server_id)->toBe($s->id)->and($tok->used_from_ip)->toBe('203.0.113.21');
    expect(AuditLog::query()->where('action', 'server.join')->value('changes'))->not->toHaveKey('hmac_key');
    // Dùng lại → 422 enrollment_invalid; hết hạn → 422.
    assertMatchesContract(P9, 'post', '/api/v1/internal/nodes:enroll', 422, p9enroll($this, $token));
    expect(p9enroll($this, $token)->json('code'))->toBe('enrollment_invalid');
    $t2 = 'itso_enr_'.str_repeat('B', 43);
    AgentEnrollmentToken::query()->create(['token_hash' => hash('sha256', $t2), 'server_name' => 'srv-node-02', 'role_tags' => [],
        'created_by_user_id' => $tok->created_by_user_id, 'expires_at' => now()->subMinute()]);
    expect(p9enroll($this, $t2)->status())->toBe(422)->and(Server::query()->where('name', 'srv-node-02')->exists())->toBeFalse();
});

it('enroll: thiếu/sai chữ ký relay → 401; CSR bị agent từ chối (CN lạ) → 422, không tạo server; sai quá 10 lần → 429', function () {
    p9agent(['pki.sign_csr' => fn () => ['__error' => ['enrollment_invalid', 'CN của CSR khác server_uuid', false]]]);
    $token = p9token();
    p9enroll($this, $token, [], str_repeat('0', 64))->assertStatus(401);
    $r = p9enroll($this, $token);
    expect($r->status())->toBe(422)->and($r->json('detail'))->toContain('CN của CSR')
        ->and(Server::query()->where('name', 'srv-node-01')->exists())->toBeFalse()
        ->and(AgentEnrollmentToken::query()->sole()->used_at)->toBeNull();
    for ($i = 0; $i < NodeEnrollController::MAX_FAILURES; $i++) {
        p9enroll($this, 'itso_enr_'.str_repeat('Z', 43));
    }
    assertMatchesContract(P9, 'post', '/api/v1/internal/nodes:enroll', 429, p9enroll($this, $token));
});

it('thu hồi node: còn account → 409, gõ sai tên → 422, máy panel → 409; đúng → revoked + đẩy danh sách thu hồi tới relay', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $node = p9remote();
    $put = [];
    Http::fake(['relay/v1/revocations' => function (Request $r) use (&$put) {
        $put[] = $r->data()['fingerprints'];

        return Http::response(['revoked' => count($r->data()['fingerprints'])]);
    }]);
    $acc = HostingAccount::factory()->create(['server_id' => $node->id]);
    $sa->post("/api/v1/admin/servers/{$node->uuid}:revoke", ['confirm_name' => $node->name])->assertStatus(409);
    $acc->forceDelete();
    $sa->post("/api/v1/admin/servers/{$node->uuid}:revoke", ['confirm_name' => 'khac'])->assertStatus(422);
    Agent::query()->create(['server_id' => $a->server->id, 'transport' => 'local']);
    $sa->post("/api/v1/admin/servers/{$a->server->uuid}:revoke", ['confirm_name' => $a->server->name])->assertStatus(409);
    $a->spa('AD_IN')->post("/api/v1/admin/servers/{$node->uuid}:revoke", ['confirm_name' => $node->name])->assertForbidden();
    $r = $sa->post("/api/v1/admin/servers/{$node->uuid}:revoke", ['confirm_name' => $node->name]);
    assertMatchesContract(P9, 'post', '/api/v1/admin/servers/{id}:revoke', 200, $r);
    expect($r->json('data.connection'))->toBe('revoked')->and($r->json('data.accepting_new_accounts'))->toBeFalse()
        ->and($put)->toBe([[hash('sha256', $node->name)]])
        ->and(AgentCertificate::query()->where('server_id', $node->id)->value('revoked_reason'))->toBe('revoke')
        ->and(AuditLog::query()->where('action', 'server.revoke')->exists())->toBeTrue();
    // Node bị thu hồi: không gửi op nữa.
    expect(fn () => app(AgentClient::class)->forServer($node->id))->toThrow(AgentUnavailable::class);
});

it('job tới node mất kết nối → waiting_agent; node quay lại → relay-sync chạy tiếp với cùng op_id; quá hạn → failed agent_unreachable', function () {
    Queue::fake();
    $node = p9remote();
    $up = false;
    $opIds = [];
    Http::fake([
        'relay/v1/nodes/*' => function (Request $r) use (&$up, &$opIds) {
            $env = json_decode($r->body(), true);
            $opIds[] = $env['op_id'];

            return $up ? Http::response(['v' => 1, 'op_id' => $env['op_id'], 'ok' => true, 'data' => ['ok' => true], 'error' => null,
                'duration_ms' => 1, 'agent_version' => '0.9.0'])
                : Http::response(['code' => 'agent_unreachable'], 503);
        },
        'relay/v1/status' => function () use (&$up, $node) {
            return Http::response(['nodes' => $up ? [['server_uuid' => $node->uuid, 'connected' => true,
                'last_seen' => now()->toIso8601String(), 'fingerprint_sha256' => hash('sha256', $node->name), 'cert_not_after' => now()->addDays(5)->toIso8601String()]] : []]);
        },
        'relay/v1/revocations' => Http::response(['revoked' => 0]),
    ]);
    $job = app(JobDispatcher::class)->dispatch((new JobSpec('hosting_account.suspend', null, $node->id, 3, 600))
        ->step('account.suspend', ['username' => 'lehoa', 'reason' => 't']), null);
    app(JobRunner::class)->run($job->id);
    $job->refresh();
    expect($job->state)->toBe('waiting_agent')->and($job->attempts)->toBe(0)
        ->and((int) round($job->agent_deadline_at->diffInMinutes(now(), true)))->toBe(30);
    assertMatchesContract(P9, 'get', '/api/v1/admin/jobs/{id}', 200, (new Actors($this))->spa('SA')->get('/api/v1/admin/jobs/'.$job->uuid));
    // Danh sách lọc theo trạng thái waiting_agent (trang Tác vụ có bộ lọc này).
    $waiting = (new Actors($this))->spa('SA')->get('/api/v1/admin/jobs?filter[state]=waiting_agent')->assertOk();
    expect(collect($waiting->json('data'))->pluck('uuid')->all())->toBe([$job->uuid]);
    // Node vẫn mất: relay-sync không chạy lại job chưa tới hạn.
    $this->artisan('itso:relay-sync')->assertSuccessful();
    Queue::assertPushed(RunJob::class, 1); // chỉ lần dispatch ban đầu
    // Node quay lại → relay-sync đẩy job, chạy tiếp cùng op_id.
    $up = true;
    $this->artisan('itso:relay-sync')->assertSuccessful();
    Queue::assertPushed(RunJob::class, 2);
    app(JobRunner::class)->run($job->id);
    $job->refresh();
    expect($job->state)->toBe('succeeded')->and($job->agent_deadline_at)->toBeNull()
        ->and($opIds)->toHaveCount(2)->and($opIds[0])->toBe($opIds[1]);
    expect(Agent::query()->where('server_id', $node->id)->value('connection'))->toBe('online');
    // Job khác, node mất tới quá hạn → failed agent_unreachable.
    $up = false;
    $j2 = app(JobDispatcher::class)->dispatch((new JobSpec('hosting_account.suspend', null, $node->id, 3, 600))
        ->step('account.suspend', ['username' => 'lehoa', 'reason' => 't']), null);
    app(JobRunner::class)->run($j2->id);
    expect($j2->refresh()->state)->toBe('waiting_agent');
    $this->travel(31)->minutes();
    app(JobRunner::class)->run($j2->id);
    expect($j2->refresh()->state)->toBe('failed')->and($j2->error_code)->toBe('agent_unreachable');
    // Op đọc chờ 2 phút; hủy job đang chờ → cancelled ngay.
    $j3 = app(JobDispatcher::class)->dispatch((new JobSpec('server.facts', null, $node->id, 3, 600))->step('system.info', []), null);
    app(JobRunner::class)->run($j3->id);
    expect((int) round($j3->refresh()->agent_deadline_at->diffInMinutes(now(), true)))->toBe(2);
    expect(app(JobRunner::class)->cancel($j3)->state)->toBe('cancelled');
});

it('relay-sync: node im lặng > 5 phút → unreachable + thông báo SUPER_ADMIN; kết nối lại → online + thông báo', function () {
    $a = new Actors($this);
    $node = p9remote('srv-node-01', 'online', now()->subMinutes(6));
    $connected = false;
    Http::fake([
        'relay/v1/status' => function () use (&$connected, $node) {
            return Http::response(['nodes' => $connected ? [['server_uuid' => $node->uuid, 'connected' => true,
                'last_seen' => now()->toIso8601String(), 'fingerprint_sha256' => hash('sha256', $node->name), 'cert_not_after' => now()->toIso8601String()]] : []]);
        },
        'relay/v1/revocations' => Http::response(['revoked' => 0]),
    ]);
    $this->artisan('itso:relay-sync')->assertSuccessful();
    expect(Agent::query()->where('server_id', $node->id)->value('connection'))->toBe('unreachable')
        ->and(Notification::query()->where('user_id', $a->sa->id)->where('type', 'server.unreachable')->count())->toBe(1);
    $this->artisan('itso:relay-sync')->assertSuccessful(); // không thông báo lặp
    expect(Notification::query()->where('type', 'server.unreachable')->count())->toBe(1);
    $connected = true;
    $this->artisan('itso:relay-sync')->assertSuccessful();
    expect(Agent::query()->where('server_id', $node->id)->value('connection'))->toBe('online')
        ->and(Notification::query()->where('type', 'server.reconnected')->count())->toBe(1);
});

it('xoay chứng chỉ khi qua 2/3 hạn: CSR từ node → pki.sign_csr local → node cài; chứng chỉ cũ superseded + đẩy thu hồi', function () {
    $node = p9remote();
    $fresh = p9remote('srv-node-02');
    Agent::query()->where('server_id', $fresh->id)->update(['cert_not_before' => now()->subDay(), 'cert_expires_at' => now()->addDays(29)]);
    $agent = p9agent();
    $installed = null;
    $put = [];
    Http::fake([
        'relay/v1/nodes/*' => function (Request $r) use (&$installed) {
            $env = json_decode($r->body(), true);
            $cert = $env['params']['cert_pem'] ?? null;
            $data = $cert === null ? ['csr' => P9_CSR, 'installed' => false, 'fingerprint_sha256' => null]
                : ['csr' => null, 'installed' => true, 'fingerprint_sha256' => $installed = hash('sha256', $env['params']['server_uuid'].'1')];

            return Http::response(['v' => 1, 'op_id' => $env['op_id'], 'ok' => true, 'data' => $data, 'error' => null, 'duration_ms' => 1, 'agent_version' => '0.9.0']);
        },
        'relay/v1/revocations' => function (Request $r) use (&$put) {
            $put[] = $r->data()['fingerprints'];

            return Http::response(['revoked' => 1]);
        },
    ]);
    expect(CertRotation::due(Agent::query()->where('server_id', $node->id)->sole()))->toBeTrue()
        ->and(CertRotation::due(Agent::query()->where('server_id', $fresh->id)->sole()))->toBeFalse();
    $this->artisan('itso:certs-rotate')->expectsOutputToContain('Đã xoay 1, bỏ qua 1')->assertSuccessful();
    $ag = Agent::query()->where('server_id', $node->id)->sole();
    expect($ag->cert_fingerprint)->toBe($installed)->and($ag->cert_rotated_at)->not->toBeNull()
        ->and(AgentCertificate::query()->where('server_id', $node->id)->where('revoked_reason', 'superseded')->count())->toBe(1)
        ->and(AgentCertificate::query()->where('server_id', $node->id)->where('issued_reason', 'rotate')->whereNull('revoked_at')->count())->toBe(1)
        ->and($put[0])->toContain(hash('sha256', $node->name))
        ->and(collect($agent->calls)->where('op', 'pki.sign_csr')->count())->toBe(1);
});

it('gợi ý server (D-92): node mất kết nối bị loại kèm lý do, xếp sau server đủ điều kiện', function () {
    $a = new Actors($this);
    $a->server->forceFill(['role_tags' => ['web'], 'observed_facts' => ['disk_mb' => 100000, 'disk_used_mb' => 10000, 'ram_mb' => 8192]])->save();
    Agent::query()->create(['server_id' => $a->server->id, 'transport' => 'local', 'last_seen_at' => now()]);
    $down = p9remote('srv-node-09', 'unreachable', now()->subMinutes(10));
    $down->forceFill(['observed_facts' => ['disk_mb' => 100000, 'disk_used_mb' => 1000, 'ram_mb' => 32768]])->save();
    $pkg = $a->account->packageVersion->package ?? HostingPackage::query()->firstOrFail();
    $r = $a->spa('SA')->get('/api/v1/admin/placement/suggestions?package='.$pkg->uuid);
    assertMatchesContract(P9, 'get', '/api/v1/admin/placement/suggestions', 200, $r);
    $rows = collect($r->json('data'));
    $first = $rows->first();
    $node = $rows->firstWhere('server.name', 'srv-node-09');
    expect($first['server']['name'])->toBe($a->server->name)->and($first['eligible'])->toBeTrue()
        ->and($node['eligible'])->toBeFalse()->and($node['excluded_reasons'])->toContain('Kết nối agent: unreachable');
});

it('ma trận quyền: ADMIN chỉ thấy server được giao (node ngoài phạm vi → 404), không thu hồi node được', function () {
    $a = new Actors($this);
    $node = p9remote();
    $in = $a->spa('AD_IN');
    $uuids = collect($in->get('/api/v1/admin/servers')->assertOk()->json('data'))->pluck('uuid')->all();
    expect($uuids)->toContain($a->server->uuid)->not->toContain($node->uuid);
    $in->get('/api/v1/admin/servers/'.$node->uuid)->assertNotFound();
    expect($in->post('/api/v1/admin/servers/'.$node->uuid.':revoke', ['confirm_name' => $node->name])->status())->toBeIn([403, 404]);
    expect($a->spa('AD_OUT')->get('/api/v1/admin/servers')->assertOk()->json('data'))->toBe([]);
    expect(Agent::query()->where('server_id', $node->id)->value('connection'))->toBe('online');
});
