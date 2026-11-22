<?php

use App\Domain\Jobs\JobRunner;
use App\Infrastructure\Agent\AgentClient;
use App\Models\AccountMigration;
use App\Models\Agent;
use App\Models\AuditLog;
use App\Models\BackupSnapshot;
use App\Models\Database;
use App\Models\DnsProvider;
use App\Models\DnsRecord;
use App\Models\DnsZone;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\RestoreJob;
use App\Models\Server;
use App\Models\Website;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\Support\Actors;

require_once __DIR__.'/../Phase8/helpers.php';

// Prompt 9.6: chuyển account giữa server (preflight → sync → verify → cutover → holding → cleanup; rollback; DNS;
// node mất kết nối giữa chừng) + khôi phục chéo server. Nguồn = server local (agent giả), đích = node mTLS qua relay giả.

if (! defined('P96')) {
    define('P96', 'itso-admin-v1.yaml');
}

/** Node mTLS online (đích) có IP để đổi DNS. */
function p96node(string $name = 'srv-hn-02'): Server
{
    $s = Server::factory()->create(['name' => $name, 'node_role' => 'node', 'role_tags' => ['web'], 'ip_addresses' => ['203.0.113.22']]);
    $a = Agent::query()->create(['server_id' => $s->id, 'transport' => 'mtls', 'connection' => 'online', 'last_seen_at' => now(),
        'cert_fingerprint' => hash('sha256', $name), 'cert_not_before' => now()->subDays(1), 'cert_expires_at' => now()->addDays(29)]);
    DB::table('agents')->where('id', $a->id)->update(['hmac_key_encrypted' => AgentClient::encryptKey(str_repeat('m', 43))]);

    return $s;
}

/** Heartbeat mới cho node (Actors::spa() tua giờ nên last_seen dễ cũ). */
function p96touch(Server $s): void
{
    Agent::query()->where('server_id', $s->id)->update(['last_seen_at' => now(), 'connection' => 'online']);
}

/**
 * Relay giả cho node đích: trả lời theo op (kiểm params/result theo contracts/agent-ops), ghi lại op.
 * `$state['down']` = true → relay trả 503 agent_unreachable.
 *
 * @param  array<string, callable>  $over
 */
function p96relay(array &$errors, array &$calls, array &$state, array $over = []): void
{
    $ok = fn (string $kind, string $name) => ['kind' => $kind, 'name' => $name, 'ok' => true, 'detail' => 'khớp'];
    $base = [
        'migrate.preflight' => fn () => ['ok' => true, 'checks' => [['key' => 'disk', 'level' => 'ok', 'message' => 'Đủ dung lượng'],
            ['key' => 'php', 'level' => 'ok', 'message' => 'Có PHP 8.3']]],
        'migrate.verify' => fn (array $env) => ['ok' => true, 'checks' => array_merge([$ok('files', 'demo.vn'), $ok('ownership', 'demo.vn')],
            array_map(fn ($d) => $ok('database', $d['name']), $env['params']['databases']))],
        'migrate.cutover' => fn () => ['done' => true, 'at' => now()->toIso8601String()],
        'migrate.rollback' => fn () => ['rolled_back' => true],
        'http.check' => fn () => ['status' => 200, 'ok' => true, 'duration_ms' => 9, 'body_sha256' => hash('sha256', 'ok')],
        'backup.restore' => fn (array $env) => ['restored_paths' => ['sites/demo.vn'], 'databases' => array_values(array_map(
            fn ($i) => $i['target_name'], array_filter($env['params']['items'], fn ($i) => $i['kind'] === 'database'))),
            'pre_restore_snapshot_id' => null, 'skipped' => []],
    ];
    $handlers = $over + $base;
    Http::fake(['relay/v1/nodes/*' => function (Request $r) use (&$errors, &$calls, &$state, $handlers) {
        if ($state['down'] ?? false) {
            return Http::response(['code' => 'agent_unreachable'], 503);
        }
        $env = json_decode($r->body(), true);
        $op = (string) $env['op'];
        $calls[] = $op;
        $out = isset($handlers[$op]) ? $handlers[$op]($env) : ['ok' => true];
        if (isset($handlers[$op]) && ($e = p8schema($op, $env['params'], 'params')) !== null) {
            $errors[] = $e;
        }
        $err = $out['__error'] ?? null;
        if ($err === null && isset($handlers[$op]) && ($e = p8schema($op, $out, 'result')) !== null) {
            $errors[] = $e;
        }

        return Http::response(['v' => 1, 'op_id' => $env['op_id'], 'ok' => $err === null, 'data' => $err === null ? $out : null,
            'error' => $err === null ? null : ['code' => $err[0], 'message' => $err[1], 'retryable' => $err[2] ?? false],
            'duration_ms' => 3, 'agent_version' => '0.9.0', 'cached' => false]);
    }]);
    config(['itso.relay.socket' => '/tmp/itso-test-relay.sock']);
    app()->forgetInstance(AgentClient::class);
}

/** Đích backup local (SA tạo qua API). */
function p96dest(Actors $a): void
{
    $a->spa('SA')->post('/api/v1/admin/backup-destinations', ['name' => 'Đích local', 'type' => 'local', 'config' => ['path' => '/var/backups/itso']])
        ->assertCreated();
}

/** Account mẫu có 1 website + 1 DB ở server nguồn; đích backup local. */
function p96setup(Actors $a): void
{
    $a->server->forceFill(['ip_addresses' => ['203.0.113.10']])->save();
    p96dest($a);
    Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'primary_domain' => 'demo.vn', 'status' => 'ready']);
    Database::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'engine' => 'mariadb',
        'name' => $a->account->username.'_web', 'charset' => 'utf8mb4', 'status' => 'ready', 'size_mb' => 1]);
}

it('chuyển trọn vẹn: preflight → sync → verifying → cutover → holding (account sang đích, đo downtime) → dọn nguồn → completed', function () {
    $errors = [];
    $calls = [];
    $state = [];
    $src = p8agent($errors);
    $a = new Actors($this);
    p96setup($a);
    $sa = $a->spa('SA');
    $in = $a->spa('AD_IN');
    $node = p96node();
    p96relay($errors, $calls, $state);
    $acc = $a->account;

    // Preflight: SA thấy kiểm tra + ước lượng; cùng server / ADMIN không có phạm vi đích → 422.
    $pf = $sa->post("/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate-preflight", ['target_server_uuid' => $node->uuid]);
    assertMatchesContract(P96, 'post', '/api/v1/admin/hosting-accounts/{id}:migrate-preflight', 200, $pf);
    expect($pf->json('data.ok'))->toBeTrue()
        ->and(collect($pf->json('data.checks'))->pluck('key')->all())->toContain('connection', 'repo_local', 'disk', 'php')
        ->and($pf->json('data.estimate.downtime_sec'))->toBeGreaterThanOrEqual(30)
        ->and($calls)->toBe(['migrate.preflight']);
    assertMatchesContract(P96, 'post', '/api/v1/admin/hosting-accounts/{id}:migrate-preflight', 422,
        $sa->post("/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate-preflight", ['target_server_uuid' => $a->server->uuid]));
    expect($in->post("/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate-preflight", ['target_server_uuid' => $node->uuid])->status())->toBe(422)
        ->and($a->spa('AD_OUT')->post("/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate-preflight", ['target_server_uuid' => $node->uuid])->status())->toBe(404);

    // Bắt đầu: chặng nguồn (backup) → chặng đích (dựng + restore + verify) chạy nối nhau → verifying; account migrating.
    p96touch($node);
    $r = p8($sa, 'POST', "/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate", ['target_server_uuid' => $node->uuid, 'keep_source_days' => 3]);
    assertMatchesContract(P96, 'post', '/api/v1/admin/hosting-accounts/{id}:migrate', 202, $r);
    expect($r->json('job.type'))->toBe('hosting_account.migrate')->and($r->json('job.state'))->toBe('succeeded');
    $m = AccountMigration::query()->sole();
    expect($m->state)->toBe('verifying')->and($m->error)->toBeNull()->and($m->sync_snapshot_id)->not->toBeNull()
        ->and($m->bytes_synced)->toBe(2 * 3145728)
        ->and(collect($m->verification)->every(fn ($c) => $c['ok']))->toBeTrue()
        ->and($acc->refresh()->lifecycle_state)->toBe('migrating')->and($acc->server_id)->toBe($a->server->id)
        ->and($src->ops())->toBe(['backup.repo.init', 'backup.run', 'backup.run', 'backup.stats'])
        ->and($calls)->toContain('account.ensure', 'db.mysql.owner_ensure', 'db.mysql.create', 'fs.site_layout.ensure', 'backup.restore',
            'nginx.vhost.apply', 'migrate.verify')
        ->and(array_search('account.ensure', $calls))->toBeLessThan(array_search('backup.restore', $calls))
        ->and(array_search('backup.restore', $calls))->toBeLessThan(array_search('migrate.verify', $calls));
    $sync = Job::query()->where('type', 'migration.sync')->sole();
    expect($sync->server_id)->toBe($node->id)->and($sync->state)->toBe('succeeded');

    $show = $in->get('/api/v1/admin/account-migrations/'.$m->uuid);
    expect($show->status())->toBe(404); // ADMIN không có phạm vi server đích
    $show = $sa->get('/api/v1/admin/account-migrations/'.$m->uuid);
    assertMatchesContract(P96, 'get', '/api/v1/admin/account-migrations/{id}', 200, $show);
    expect($show->json('data.state'))->toBe('verifying')->and($show->json('data.target_server.name'))->toBe('srv-hn-02')
        ->and($show->json('data.dns.mode'))->toBe('manual')->and($show->json('data.dns.records.0'))->toEqual(['type' => 'A', 'name' => 'demo.vn', 'value' => '203.0.113.22']);
    assertMatchesContract(P96, 'get', '/api/v1/admin/account-migrations', 200, $sa->get('/api/v1/admin/account-migrations'));
    expect($in->get('/api/v1/admin/account-migrations')->json('data'))->toBe([]);

    // Portal: thấy "đang chuyển"; thao tác ghi bị chặn 409. Lượt chuyển thứ hai cùng lúc → 409.
    $own = $a->spa('US_OWNER');
    expect($own->get('/api/v1/portal/hosting-accounts/'.$acc->uuid)->json('data.lifecycle_state'))->toBe('migrating');
    expect(collect($own->get('/api/v1/portal/overview')->json('data.warnings'))->pluck('code')->all())->toContain('account_migrating');
    expect(p8($own, 'POST', '/api/v1/portal/cron-jobs', ['hosting_account_uuid' => $acc->uuid, 'schedule' => '0 3 * * *', 'command' => 'true'])->status())->toBe(409);
    $sa = $a->spa('SA');
    p96touch($node);
    expect(p8($sa, 'POST', "/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate", ['target_server_uuid' => $node->uuid])->status())->toBe(409);

    // Dọn nguồn trước cutover → 409.
    expect(p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:cleanup", ['confirm_username' => $acc->username])->status())->toBe(409);

    // Cutover: nguồn khóa + backup lượt cuối → đích restore lượt cuối, verify, mở, http.check → holding.
    $calls = [];
    p96touch($node);
    $c = p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:cutover");
    assertMatchesContract(P96, 'post', '/api/v1/admin/account-migrations/{id}:cutover', 202, $c);
    $m->refresh();
    expect($m->state)->toBe('holding')->and($m->final_snapshot_id)->not->toBeNull()->and($m->downtime_sec)->toBeGreaterThanOrEqual(0)
        ->and($m->cleanup_after->diffInDays(now(), true))->toBeGreaterThan(2.9)
        ->and(collect($m->verification)->where('kind', 'http')->pluck('name')->all())->toBe(['demo.vn'])
        ->and($calls[0])->toBe('backup.restore')
        ->and(array_slice($calls, -2))->toBe(['migrate.cutover', 'http.check'])
        ->and(collect($src->calls)->where('op', 'migrate.cutover')->first()['params']['role'])->toBe('source')
        ->and(collect($src->calls)->where('op', 'backup.run')->last()['params']['tags'])->toContain('final');
    $acc->refresh();
    expect($acc->server_id)->toBe($node->id)->and($acc->lifecycle_state)->toBe('active')
        ->and(Website::query()->where('hosting_account_id', $acc->id)->value('server_id'))->toBe($node->id)
        ->and(Database::query()->where('hosting_account_id', $acc->id)->value('server_id'))->toBe($node->id)
        ->and(DB::table('uid_allocations')->where('server_id', $node->id)->where('uid', $acc->uid)->whereNull('released_at')->exists())->toBeTrue();
    // Portal ghi lại được: job chạy ở server mới (qua relay).
    $calls = [];
    p96touch($node);
    $cr = p8($a->spa('US_OWNER'), 'POST', '/api/v1/portal/cron-jobs', ['hosting_account_uuid' => $acc->uuid, 'schedule' => '0 3 * * *', 'command' => 'true']);
    expect($cr->status())->toBe(202)->and($calls)->toContain('cron.apply');
    expect(AuditLog::query()->where('action', 'migration.cutover')->exists())->toBeTrue();

    // Dọn sớm: sai username → 422; ADMIN (đã có phạm vi cả hai server) dọn sớm trước hạn → 403; SA dọn sớm → completed.
    expect(p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:cleanup", ['confirm_username' => 'sai'])->status())->toBe(422);
    DB::table('user_scopes')->insert(['user_id' => $a->adminIn->id, 'scope_type' => 'server', 'scope_id' => $node->id]);
    $in = $a->spa('AD_IN');
    $early = p8($in, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:cleanup", ['confirm_username' => $acc->username]);
    expect($early->status())->toBe(403);
    $sa = $a->spa('SA');
    $cl = p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:cleanup", ['confirm_username' => $acc->username]);
    assertMatchesContract(P96, 'post', '/api/v1/admin/account-migrations/{id}:cleanup', 202, $cl);
    $rm = collect($src->calls)->where('op', 'account.remove')->last();
    expect($rm['params']['reason'])->toBe('migrated')->and($rm['params']['ref_uuid'])->toBe($m->uuid)
        ->and($m->refresh()->state)->toBe('completed')->and($m->cleaned_at)->not->toBeNull()
        ->and(DB::table('uid_allocations')->where('server_id', $a->server->id)->where('uid', $acc->uid)->whereNull('released_at')->exists())->toBeFalse();
    // Đã dọn → không hoàn tác được.
    expect(p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:rollback")->status())->toBe(409);
    expect($errors)->toBe([]);
});

it('preflight chặn: đích thiếu PHP/đĩa/domain trùng, node mất kết nối, thiếu đích backup → không tạo lượt chuyển', function () {
    $errors = [];
    $calls = [];
    $state = [];
    p8agent($errors);
    $a = new Actors($this);
    $a->server->forceFill(['ip_addresses' => ['203.0.113.10']])->save();
    Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'primary_domain' => 'demo.vn', 'status' => 'ready']);
    $sa = $a->spa('SA');
    $node = p96node();
    p96relay($errors, $calls, $state, ['migrate.preflight' => fn () => ['ok' => false, 'checks' => [
        ['key' => 'php', 'level' => 'block', 'message' => 'Thiếu PHP 8.3 ở đích'],
        ['key' => 'disk', 'level' => 'block', 'message' => 'Thiếu dung lượng'],
        ['key' => 'domain', 'level' => 'block', 'message' => 'demo.vn đã có ở đích'],
    ]]]);
    $acc = $a->account;

    // Chưa có đích backup → block repo (không gọi agent đích).
    $pf = $sa->post("/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate-preflight", ['target_server_uuid' => $node->uuid]);
    expect($pf->json('data.ok'))->toBeFalse()->and(collect($pf->json('data.checks'))->firstWhere('key', 'repo')['level'])->toBe('block')
        ->and($calls)->toBe([]);
    p96dest($a);
    $sa = $a->spa('SA');
    p96touch($node);
    $pf = $sa->post("/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate-preflight", ['target_server_uuid' => $node->uuid]);
    expect($pf->json('data.ok'))->toBeFalse()
        ->and(collect($pf->json('data.checks'))->where('level', 'block')->pluck('key')->all())->toBe(['php', 'disk', 'domain']);
    p96touch($node);
    $r = p8($sa, 'POST', "/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate", ['target_server_uuid' => $node->uuid]);
    assertMatchesContract(P96, 'post', '/api/v1/admin/hosting-accounts/{id}:migrate', 409, $r);
    expect($r->json('code'))->toBe('precondition_failed')->and($r->json('detail'))->toContain('Thiếu PHP 8.3')
        ->and(AccountMigration::query()->count())->toBe(0)->and($acc->refresh()->lifecycle_state)->toBe('active');

    // Node mất kết nối → block connection; account không active → block.
    Agent::query()->where('server_id', $node->id)->update(['last_seen_at' => now()->subMinutes(10)]);
    $pf = $sa->post("/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate-preflight", ['target_server_uuid' => $node->uuid]);
    expect(collect($pf->json('data.checks'))->firstWhere('key', 'connection')['level'])->toBe('block');
    HostingAccount::query()->whereKey($acc->id)->update(['lifecycle_state' => 'suspended']);
    $pf = $sa->post("/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate-preflight", ['target_server_uuid' => $node->uuid]);
    expect(collect($pf->json('data.checks'))->firstWhere('key', 'account')['level'])->toBe('block');
    expect($errors)->toBe([]);
});

it('repo backup chưa khởi tạo: preflight chỉ cảnh báo; chặng đích kiểm tra lại vẫn chặn → lượt chuyển failed, account về active ở nguồn', function () {
    $errors = [];
    $calls = [];
    $state = [];
    p8agent($errors);
    $a = new Actors($this);
    p96setup($a);
    $sa = $a->spa('SA');
    $node = p96node();
    // Agent đích luôn báo không đọc được repo (ở preflight: repo chưa init; ở đầu chặng đích: lỗi thật).
    // Ở chặng đích panel gửi enforce=true: agent trả lỗi precondition_failed thay vì checks.
    p96relay($errors, $calls, $state, ['migrate.preflight' => fn (array $env) => ($env['params']['enforce'] ?? false)
        ? ['__error' => ['precondition_failed', 'kiểm tra trước ở đích chặn: Không đọc được repo backup']]
        : ['ok' => false, 'checks' => [
            ['key' => 'repo', 'level' => 'block', 'message' => 'Không đọc được repo backup'],
            ['key' => 'disk', 'level' => 'ok', 'message' => 'Đủ dung lượng'],
        ]]]);
    $acc = $a->account;

    $pf = $sa->post("/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate-preflight", ['target_server_uuid' => $node->uuid]);
    assertMatchesContract(P96, 'post', '/api/v1/admin/hosting-accounts/{id}:migrate-preflight', 200, $pf);
    $repo = collect($pf->json('data.checks'))->firstWhere('key', 'repo');
    expect($pf->json('data.ok'))->toBeTrue()->and($repo['level'])->toBe('warn')->and($repo['message'])->toContain('chưa khởi tạo');

    p96touch($node);
    $r = p8($sa, 'POST', "/api/v1/admin/hosting-accounts/{$acc->uuid}:migrate", ['target_server_uuid' => $node->uuid]);
    expect($r->status())->toBe(202);
    $m = AccountMigration::query()->sole();
    expect($m->state)->toBe('failed')->and($m->error)->toContain('[precondition_failed] kiểm tra trước ở đích chặn: Không đọc được repo backup')
        ->and($acc->refresh()->lifecycle_state)->toBe('active')->and($acc->server_id)->toBe($a->server->id)
        ->and($calls)->not->toContain('account.ensure')->and($calls)->not->toContain('backup.restore');
    expect($errors)->toBe([]);
});

it('kiểm chứng lệch → không cutover (409); hoàn tác ở verifying: đích khóa → nguồn mở, account về active ở nguồn', function () {
    $errors = [];
    $calls = [];
    $state = [];
    $src = p8agent($errors);
    $a = new Actors($this);
    p96setup($a);
    $sa = $a->spa('SA');
    $node = p96node();
    p96relay($errors, $calls, $state, ['migrate.verify' => fn () => ['ok' => false, 'checks' => [
        ['kind' => 'files', 'name' => 'demo.vn', 'ok' => true, 'detail' => 'khớp'],
        ['kind' => 'database', 'name' => $a->account->username.'_web', 'ok' => false, 'detail' => 'sha256 dump lệch'],
    ]]]);
    p8($sa, 'POST', "/api/v1/admin/hosting-accounts/{$a->account->uuid}:migrate", ['target_server_uuid' => $node->uuid])->assertStatus(202);
    $m = AccountMigration::query()->sole();
    expect($m->state)->toBe('verifying')->and($m->error)->toContain('Kiểm chứng lệch');

    $c = p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:cutover");
    assertMatchesContract(P96, 'post', '/api/v1/admin/account-migrations/{id}:cutover', 409, $c);
    expect($c->json('code'))->toBe('precondition_failed')->and($src->ops())->not->toContain('migrate.cutover');

    $calls = [];
    $rb = p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:rollback");
    assertMatchesContract(P96, 'post', '/api/v1/admin/account-migrations/{id}:rollback', 202, $rb);
    expect($rb->json('job.type'))->toBe('migration.rollback')->and($calls)->toBe(['migrate.rollback'])
        ->and(collect($src->calls)->where('op', 'migrate.rollback')->last()['params']['role'])->toBe('source')
        ->and($m->refresh()->state)->toBe('rolled_back')
        ->and($a->account->refresh()->lifecycle_state)->toBe('active')->and($a->account->server_id)->toBe($a->server->id);
    // Đã hoàn tác → không hoàn tác/cutover lại.
    expect(p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:rollback")->status())->toBe(409);
    expect($errors)->toBe([]);
});

it('DNS tự động (zone Cloudflare): giảm TTL lúc đồng bộ, đổi A sang đích lúc cutover; hoàn tác sau cutover trả DNS + account về nguồn', function () {
    $errors = [];
    $calls = [];
    $state = [];
    $src = p8agent($errors);
    $a = new Actors($this);
    p96setup($a);
    $sa = $a->spa('SA');
    $node = p96node();
    $patches = [];
    Http::fake(['api.cloudflare.com/*' => function (Request $r) use (&$patches) {
        $patches[] = [$r->method(), $r->data()];

        return Http::response(['success' => true, 'errors' => [], 'result' => ['id' => 'r1']]);
    }]);
    p96relay($errors, $calls, $state);
    $p = DnsProvider::query()->create(['type' => 'cloudflare', 'name' => 'CF', 'credentials_encrypted' => Crypt::encryptString(json_encode(['api_token' => 'cf_x']))]);
    $z = DnsZone::query()->create(['provider_id' => $p->id, 'name' => 'demo.vn', 'external_id' => str_repeat('a', 32)]);
    $rec = DnsRecord::query()->create(['zone_id' => $z->id, 'type' => 'A', 'name' => '@', 'content' => '203.0.113.10', 'ttl' => 3600, 'external_id' => 'r1']);

    p8($sa, 'POST', "/api/v1/admin/hosting-accounts/{$a->account->uuid}:migrate", ['target_server_uuid' => $node->uuid])->assertStatus(202);
    $m = AccountMigration::query()->sole();
    expect($m->state)->toBe('verifying')->and($m->dns['mode'])->toBe('auto')->and($m->dns['zone'])->toBe('demo.vn')
        ->and($rec->refresh()->ttl)->toBe(60)->and($rec->content)->toBe('203.0.113.10');

    p96touch($node);
    p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:cutover")->assertStatus(202);
    expect($m->refresh()->state)->toBe('holding')->and($m->dns['switched'])->toBeTrue()
        ->and($rec->refresh()->content)->toBe('203.0.113.22')->and($patches)->toHaveCount(2);

    // Hoàn tác sau cutover (đang giữ nguồn): đích khóa + DNS về nguồn → nguồn mở; account/site/DB về server nguồn.
    $calls = [];
    p96touch($node);
    p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:rollback")->assertStatus(202);
    expect($calls)->toBe(['migrate.rollback'])->and($rec->refresh()->content)->toBe('203.0.113.10')
        ->and($m->refresh()->state)->toBe('rolled_back')->and($a->account->refresh()->server_id)->toBe($a->server->id)
        ->and(Website::query()->where('hosting_account_id', $a->account->id)->value('server_id'))->toBe($a->server->id)
        ->and(DB::table('uid_allocations')->where('server_id', $node->id)->where('uid', $a->account->uid)->whereNull('released_at')->exists())->toBeFalse()
        ->and($src->ops())->toContain('migrate.rollback');
    expect($errors)->toBe([]);
});

it('node đích mất kết nối giữa chặng đồng bộ → job chờ node có hạn; quá hạn → lượt chuyển failed, account hoạt động lại ở nguồn', function () {
    $errors = [];
    $calls = [];
    $state = [];
    // Agent nguồn giả riêng: backup xong (backup.stats) thì node đích rơi khỏi relay trước chặng đồng bộ.
    config(['itso.agent.socket' => null, 'itso.agent.url' => 'http://agent.test']);
    Http::fake(['agent.test/v1/ops' => function (Request $r) use (&$state) {
        $env = json_decode($r->body(), true);
        if ($env['op'] === 'backup.stats') {
            $state['down'] = true; // nguồn backup xong → node đích rơi
        }
        $out = match ($env['op']) {
            'backup.run' => ['snapshot_id' => bin2hex(random_bytes(8)), 'size_bytes' => 10, 'bytes_added' => 1, 'files_new' => 1, 'duration_ms' => 1,
                'manifest_sha256' => hash('sha256', 'm')],
            'backup.stats' => ['raw_size_bytes' => 1, 'restore_size_bytes' => 1, 'snapshots' => 2],
            default => ['ok' => true],
        };

        return Http::response(['v' => 1, 'op_id' => $env['op_id'], 'ok' => true, 'data' => $out, 'error' => null, 'duration_ms' => 1,
            'agent_version' => 't', 'cached' => false]);
    }]);
    $a = new Actors($this);
    p96setup($a);
    $sa = $a->spa('SA');
    $node = p96node();
    p96relay($errors, $calls, $state);
    p8($sa, 'POST', "/api/v1/admin/hosting-accounts/{$a->account->uuid}:migrate", ['target_server_uuid' => $node->uuid])->assertStatus(202);
    $m = AccountMigration::query()->sole();
    $sync = Job::query()->where('type', 'migration.sync')->sole();
    expect($sync->state)->toBe('waiting_agent')->and($sync->agent_deadline_at)->not->toBeNull()
        ->and($m->state)->toBe('syncing')->and($a->account->refresh()->lifecycle_state)->toBe('migrating');
    // Đang có chặng chạy → không hoàn tác chen ngang.
    expect(p8($sa, 'POST', "/api/v1/admin/account-migrations/{$m->uuid}:rollback")->status())->toBe(409);

    $this->travel(31)->minutes();
    app(JobRunner::class)->run($sync->id);
    expect($sync->refresh()->state)->toBe('failed')->and($sync->error_code)->toBe('agent_unreachable')
        ->and($m->refresh()->state)->toBe('failed')->and($m->error)->toContain('migration.sync')
        ->and($a->account->refresh()->lifecycle_state)->toBe('active')->and($a->account->server_id)->toBe($a->server->id);
    expect(json_decode((string) DB::table('notifications')->where('type', 'migration.failed')->value('data'), true)['link'])->toBe('/hosting-accounts/'.$a->account->uuid.'/migrate');
    expect($errors)->toBe([]);
});

it('khôi phục chéo server: chỉ Admin có phạm vi đích, chỉ bản mới, node phải online; job chạy ở đích (account.ensure → restore)', function () {
    $errors = [];
    $calls = [];
    $state = [];
    p8agent($errors);
    $a = new Actors($this);
    p96setup($a);
    $sa = $a->spa('SA');
    p8($sa, 'POST', '/api/v1/admin/backups', ['hosting_account_uuid' => $a->account->uuid, 'contents' => ['files', 'databases']])->assertStatus(202);
    $snap = BackupSnapshot::query()->where('scope_type', 'hosting_account')->firstOrFail();
    $node = p96node();
    p96relay($errors, $calls, $state);

    $r = p8($sa, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $snap->uuid, 'mode' => 'new', 'items' => ['files:sites/demo.vn'], 'target_server_uuid' => $node->uuid]);
    assertMatchesContract(P8A, 'post', '/api/v1/admin/restores', 202, $r);
    $rj = RestoreJob::query()->latest('id')->firstOrFail();
    expect($rj->target_server_id)->toBe($node->id)->and($rj->status)->toBe('succeeded')
        ->and($calls)->toBe(['account.ensure', 'backup.restore'])
        ->and(Job::query()->latest('id')->first()->server_id)->toBe($node->id)
        ->and($a->account->refresh()->server_id)->toBe($a->server->id);

    p96touch($node);
    expect(p8($sa, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $snap->uuid, 'mode' => 'overwrite', 'items' => ['website:demo.vn'],
        'confirm' => $a->account->username, 'target_server_uuid' => $node->uuid])->status())->toBe(422);
    expect(p8($a->spa('AD_IN'), 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $snap->uuid, 'mode' => 'new', 'items' => ['files:x'],
        'target_server_uuid' => $node->uuid])->status())->toBe(422);
    Agent::query()->where('server_id', $node->id)->update(['last_seen_at' => now()->subHour()]);
    $sa = $a->spa('SA');
    $off = p8($sa, 'POST', '/api/v1/admin/restores', ['snapshot_uuid' => $snap->uuid, 'mode' => 'new', 'items' => ['files:x'], 'target_server_uuid' => $node->uuid]);
    expect($off->status())->toBe(409)->and($off->json('code'))->toBe('agent_unreachable');
    expect($errors)->toBe([]);
});
