<?php

use App\Domain\Jobs\Secrets;
use App\Models\Agent;
use App\Models\AuditLog;
use App\Models\Certificate;
use App\Models\CronJob;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\HostingPackageVersion;
use App\Models\ImportItem;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\PanelImport;
use App\Models\PhpVersion;
use App\Models\User;
use App\Models\Website;
use App\Models\WebsiteDomain;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;
use Tests\Support\Spa;

require_once __DIR__.'/../Phase8/helpers.php';

// Prompt 12.3: import từ aaPanel/HestiaCP/nginx trên cùng máy (D-108, ADR 0053): quét (job chỉ đọc) → kế hoạch (map
// username/gói/USER, kiểm trùng + hạn mức) → chạy (mỗi account một job, DB qua dump/import, mật khẩu DB chỉ qua tham
// chiếu bí mật) → cutover (tắt vhost nguồn, ACME) → quay lại. Params/result op import.* được kiểm theo contracts/agent-ops.

if (! defined('P12A')) {
    define('P12A', 'itso-admin-v1.yaml');
}

/** import.scan giả: 3 site aaPanel (SSL còn hạn + DB + cron; PHP 7.4; một domain đã có trong ITSO). */
function p12scan(): array
{
    $site = fn (string $d, ?string $php, array $over = []) => $over + ['domain' => $d, 'aliases' => ['www.'.$d],
        'docroot' => '/www/wwwroot/'.$d, 'vhost_path' => '/www/server/panel/vhost/nginx/'.$d.'.conf', 'php_version' => $php,
        'ssl' => ['cert_path' => null, 'not_after' => null], 'size_bytes' => 50 * 1048576, 'files' => 120, 'databases' => [],
        'crons' => [], 'system_user' => 'www', 'warnings' => []];

    return ['source_version' => 'aaPanel 7.0.9', 'truncated' => false, 'sites' => [
        $site('shop.anphat.vn', '8.2', ['ssl' => ['cert_path' => '/www/server/panel/vhost/cert/shop.anphat.vn/fullchain.pem',
            'not_after' => now()->addDays(60)->toIso8601String()],
            'databases' => [['name' => 'shop_anphat', 'size_bytes' => 30 * 1048576]],
            'crons' => [['schedule' => '*/5 * * * *', 'command' => 'php /www/wwwroot/shop.anphat.vn/cron.php']]]),
        $site('blog.anphat.vn', '7.4', ['warnings' => [['code' => 'php_missing', 'message' => 'PHP 7.4 không có trong ITSO']]]),
        $site('cu.anphat.vn', '8.3'),
    ]];
}

/** Agent giả: op import.* + cert.issue kiểm theo contracts; op hạ tầng khác trả {ok: true}. */
function p12agent(array &$errors, array $over = []): FakeAgent
{
    return p8agent($errors, $over + [
        'import.scan' => fn () => p12scan(),
        'import.copy' => fn () => ['files' => 120, 'bytes' => 50 * 1048576, 'skipped' => 1, 'skipped_reasons' => ['symlink ra ngoài: etc-link']],
        'import.db_dump' => fn () => ['size' => 4096, 'sha256' => hash('sha256', 'dump'), 'tables' => 12],
        'db.mysql.import' => fn () => ['bytes' => 4096],
        'import.cutover' => fn (array $e) => ['disabled' => $e['params']['vhost_paths']],
        'import.rollback' => fn (array $e) => ['restored' => $e['params']['vhost_paths']],
        'cert.issue' => fn (array $e) => ['cert_uuid' => $e['params']['cert_uuid'], 'issuer' => "Let's Encrypt",
            'not_before' => now()->toIso8601String(), 'not_after' => now()->addDays(90)->toIso8601String(), 'domains' => $e['params']['domains']],
    ]);
}

/** Server có agent local online, PHP 8.2/8.3 sẵn sàng, domain cu.anphat.vn đã có trong ITSO; trả [SA, gói Business, gói Mini]. */
function p12setup(Actors $a): array
{
    Agent::query()->create(['server_id' => $a->server->id, 'transport' => 'local', 'last_seen_at' => now()]);
    foreach (['8.2', '8.3'] as $v) {
        PhpVersion::query()->create(['server_id' => $a->server->id, 'version' => $v, 'status' => 'ready', 'extensions' => [],
            'spec_version' => 1, 'observed_version' => 1]);
    }
    $w = Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'primary_domain' => 'cu.anphat.vn', 'status' => 'ready']);
    WebsiteDomain::query()->create(['website_id' => $w->id, 'name' => 'cu.anphat.vn', 'type' => 'primary']);
    $biz = HostingPackage::factory()->create(['code' => 'business', 'name' => 'Business']);
    $mini = HostingPackage::query()->create(['code' => 'mini', 'name' => 'Mini', 'current_version' => 1, 'is_active' => true]);
    HostingPackageVersion::factory()->create(['package_id' => $mini->id, 'version' => 1, 'website_limit' => 1, 'database_limit' => 0]);

    return [$a->spa('SA'), $biz, $mini];
}

function p12touch(Actors $a): void
{
    Agent::query()->where('server_id', $a->server->id)->update(['last_seen_at' => now()]);
}

/** Quét xong → lượt import planned. */
function p12scanned(Actors $a, Spa $sa): PanelImport
{
    p12touch($a);
    $r = p8($sa, 'POST', '/api/v1/admin/imports', ['source' => 'aapanel', 'server' => $a->server->uuid]);
    assertMatchesContract(P12A, 'post', '/api/v1/admin/imports', 202, $r);

    return PanelImport::query()->where('uuid', $r->json('resource.uuid'))->firstOrFail();
}

/** @return array<string, string> domain → uuid mục */
function p12items(PanelImport $imp): array
{
    return ImportItem::query()->where('import_id', $imp->id)->pluck('uuid', 'domain')->all();
}

it('quét (job chỉ đọc) → kế hoạch: mục, cảnh báo, gợi ý username, domain đã có thì bỏ chọn; khớp contract', function () {
    $errors = [];
    $agent = p12agent($errors);
    $a = new Actors($this);
    [$sa] = p12setup($a);

    $imp = p12scanned($a, $sa);
    expect($agent->ops())->toBe(['import.scan'])
        ->and($agent->calls[0]['params'])->toBe(['source' => 'aapanel', 'max_sites' => 500]);
    $imp->refresh();
    expect($imp->state)->toBe('planned')->and($imp->source_version)->toBe('aaPanel 7.0.9');

    $show = $sa->get("/api/v1/admin/imports/{$imp->uuid}");
    assertMatchesContract(P12A, 'get', '/api/v1/admin/imports/{id}', 200, $show);
    expect($show->json('data.summary'))->toBe(['sites' => 3, 'databases' => 1, 'crons' => 1, 'warnings' => 2, 'selected' => 2]);
    assertMatchesContract(P12A, 'get', '/api/v1/admin/imports', 200, $sa->get('/api/v1/admin/imports'));

    $items = $sa->get("/api/v1/admin/imports/{$imp->uuid}/items?sort=domain");
    assertMatchesContract(P12A, 'get', '/api/v1/admin/imports/{id}/items', 200, $items);
    $by = collect($items->json('data'))->keyBy('domain');
    expect($by['shop.anphat.vn']['ssl'])->toBe('valid')
        ->and($by['shop.anphat.vn']['databases'])->toBe([['name' => 'shop_anphat', 'size_mb' => 30]])
        ->and($by['shop.anphat.vn']['crons'])->toBe(1)
        ->and($by['shop.anphat.vn']['target']['username'])->toBe('shop')
        ->and($by['blog.anphat.vn']['warnings'][0]['code'])->toBe('php_missing')
        ->and($by['blog.anphat.vn']['target']['username'])->toBe('blog')
        ->and($by['cu.anphat.vn']['selected'])->toBeFalse()
        ->and(collect($by['cu.anphat.vn']['warnings'])->pluck('code')->all())->toBe(['domain_exists'])
        ->and(AuditLog::query()->where('action', 'import.scan')->count())->toBe(1);

    // Đang có lượt khác quét/chạy trên server → 409; agent mất kết nối → 409.
    PanelImport::query()->whereKey($imp->id)->update(['state' => 'running']);
    assertMatchesContract(P12A, 'post', '/api/v1/admin/imports', 409,
        p8($sa, 'POST', '/api/v1/admin/imports', ['source' => 'hestia', 'server' => $a->server->uuid]));
    PanelImport::query()->whereKey($imp->id)->update(['state' => 'planned']);
    Agent::query()->where('server_id', $a->server->id)->update(['last_seen_at' => now()->subHour()]);
    expect(p8($sa, 'POST', '/api/v1/admin/imports', ['source' => 'nginx', 'server' => $a->server->uuid])->json('code'))->toBe('agent_unreachable');
    expect($errors)->toBe([]);
});

it('quét lỗi → scan_failed kèm lỗi của agent', function () {
    $errors = [];
    p12agent($errors, ['import.scan' => fn () => ['__error' => ['not_found', 'Không thấy aaPanel (/www/server/panel/vhost/nginx)', false]]]);
    $a = new Actors($this);
    [$sa] = p12setup($a);
    $imp = p12scanned($a, $sa)->refresh();
    expect($imp->state)->toBe('scan_failed')->and($imp->error)->toContain('Không thấy aaPanel')
        ->and(ImportItem::query()->count())->toBe(0);
});

it('kế hoạch: map gói/USER, lỗi 422 theo từng mục (trùng username, khác gói cùng username, quota gói, domain đã có, email trùng)', function () {
    $errors = [];
    p12agent($errors);
    $a = new Actors($this);
    [$sa, $biz, $mini] = p12setup($a);
    $imp = p12scanned($a, $sa);
    $ids = p12items($imp);
    $url = "/api/v1/admin/imports/{$imp->uuid}/plan";

    // Username đã có trên server; site đã có trong ITSO bị chọn lại; email USER mới đã tồn tại.
    $r = $sa->call('PUT', $url, ['items' => [
        ['uuid' => $ids['shop.anphat.vn'], 'selected' => true, 'username' => $a->account->username, 'package' => $biz->uuid, 'user' => $a->owner->uuid],
        ['uuid' => $ids['blog.anphat.vn'], 'selected' => true, 'package' => $biz->uuid, 'new_user' => ['name' => 'Trùng', 'email' => $a->owner->email]],
        ['uuid' => $ids['cu.anphat.vn'], 'selected' => true],
    ]]);
    assertMatchesContract(P12A, 'put', '/api/v1/admin/imports/{id}/plan', 422, $r);
    expect(array_keys($r->json('errors')))->toEqualCanonicalizing(['items.0.username', 'items.1.new_user', 'items.2.selected']);

    // Hai mục gộp một username nhưng khác gói → lỗi gói; gói Mini (1 website, 0 DB) quá hạn mức.
    $r = $sa->call('PUT', $url, ['items' => [
        ['uuid' => $ids['shop.anphat.vn'], 'selected' => true, 'username' => 'anphat', 'package' => $biz->uuid, 'user' => $a->owner->uuid],
        ['uuid' => $ids['blog.anphat.vn'], 'selected' => true, 'username' => 'anphat', 'package' => $mini->uuid, 'user' => $a->owner->uuid],
    ]]);
    expect($r->status())->toBe(422)->and($r->json('errors'))->toHaveKeys(['items.0.package', 'items.1.package']);
    $r = $sa->call('PUT', $url, ['items' => [
        ['uuid' => $ids['shop.anphat.vn'], 'selected' => true, 'username' => 'anphat', 'package' => $mini->uuid, 'user' => $a->owner->uuid],
        ['uuid' => $ids['blog.anphat.vn'], 'selected' => true, 'username' => 'anphat', 'package' => $mini->uuid, 'user' => $a->owner->uuid],
    ]]);
    expect($r->status())->toBe(422)->and($r->json('errors')['items.0.package'][0] ?? '')->toContain('tối đa 1 website');
    // Mục lạ / USER không phải Portal → 422.
    $r = $sa->call('PUT', $url, ['items' => [['uuid' => '01938a3b-0001-7000-8000-00003b000001', 'selected' => true],
        ['uuid' => $ids['shop.anphat.vn'], 'selected' => true, 'user' => $a->sa->uuid]]]);
    expect($r->json('errors'))->toHaveKeys(['items.0.uuid', 'items.1.user']);

    // Hợp lệ: 2 site gộp account anphat (Business, chủ có sẵn).
    $ok = $sa->call('PUT', $url, ['items' => [
        ['uuid' => $ids['shop.anphat.vn'], 'selected' => true, 'username' => 'anphat', 'package' => $biz->uuid, 'user' => $a->owner->uuid],
        ['uuid' => $ids['blog.anphat.vn'], 'selected' => true, 'username' => 'anphat', 'package' => $biz->uuid, 'user' => $a->owner->uuid],
    ]]);
    assertMatchesContract(P12A, 'put', '/api/v1/admin/imports/{id}/plan', 200, $ok);
    expect($ok->json('data.summary.selected'))->toBe(2);
    $it = $sa->get("/api/v1/admin/imports/{$imp->uuid}/items?sort=domain")->json('data');
    expect($it[0]['target']['package']['code'])->toBe('business')->and($it[0]['target']['user']['uuid'])->toBe($a->owner->uuid)
        ->and(AuditLog::query()->where('action', 'import.plan')->count())->toBe(1);
    expect($errors)->toBe([]);
});

it('chạy: mỗi username một job đủ bước (account → copy uid account → pool → vhost → DB dump/import), mật khẩu DB không vào params; cutover (ACME) + quay lại', function () {
    $errors = [];
    $agent = p12agent($errors);
    $a = new Actors($this);
    [$sa, $biz] = p12setup($a);
    config(['itso.acme.email' => 'ssl@itso.vn', 'itso.acme.directory' => 'letsencrypt']);
    $imp = p12scanned($a, $sa);
    $ids = p12items($imp);
    $sa->call('PUT', "/api/v1/admin/imports/{$imp->uuid}/plan", ['items' => [
        ['uuid' => $ids['shop.anphat.vn'], 'selected' => true, 'username' => 'shopap', 'package' => $biz->uuid, 'user' => $a->owner->uuid],
        ['uuid' => $ids['blog.anphat.vn'], 'selected' => true, 'username' => 'blogap', 'package' => $biz->uuid,
            'new_user' => ['name' => 'Blog An Phát', 'email' => 'blog@anphat.vn']],
    ]])->assertOk();
    $agent->calls = [];

    p12touch($a);
    $r = p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:run");
    assertMatchesContract(P12A, 'post', '/api/v1/admin/imports/{id}:run', 202, $r);
    expect($r->json('job.type'))->toBe('import.run')->and($r->json('resource.type'))->toBe('import');
    $jobs = Job::query()->where('type', 'import.run')->orderBy('id')->get();
    expect($jobs)->toHaveCount(2)->and($jobs->pluck('state')->all())->toBe(['succeeded', 'succeeded']);

    $ops = JobStep::query()->where('job_id', $jobs[0]->id)->orderBy('seq')->pluck('op')->all();
    expect($ops)->toBe(['account.ensure', 'quota.apply', 'fs.site_layout.ensure', 'import.copy', 'php.pool.apply', 'nginx.vhost.apply',
        'db.mysql.owner_ensure', 'db.mysql.create', 'db.mysql.user_ensure', 'db.mysql.grant', 'import.db_dump', 'db.mysql.import', 'fs.delete']);
    $call = fn (string $op) => collect($agent->calls)->firstWhere('op', $op)['params'];
    expect($call('import.copy'))->toMatchArray(['source' => 'aapanel', 'src' => '/www/wwwroot/shop.anphat.vn',
        'account' => ['username' => 'shopap', 'uid' => HostingAccount::query()->where('username', 'shopap')->value('uid')],
        'dst' => 'sites/shop.anphat.vn/public/site'])
        ->and($call('import.db_dump')['source_db'])->toBe('shop_anphat')
        ->and($call('db.mysql.import')['name'])->toBe('shopap_anphat')
        ->and(Secrets::isRef(JobStep::query()->where('job_id', $jobs[0]->id)->where('op', 'db.mysql.user_ensure')->first()->params_redacted['password']))->toBeTrue();
    // Mật khẩu DB sinh ở panel: job_steps chỉ giữ tham chiếu (giá trị thật chỉ lúc gửi agent), không lộ ở job/audit.
    $pw = Crypt::decryptString((string) DatabaseUser::query()->where('username', 'shopap_anphat')->value('password_encrypted'));
    expect(p8leak($pw))->toBeNull();

    $imp->refresh();
    expect($imp->state)->toBe('completed');
    $shop = HostingAccount::query()->where('username', 'shopap')->firstOrFail();
    $blog = HostingAccount::query()->where('username', 'blogap')->firstOrFail();
    $newOwner = User::query()->where('email', 'blog@anphat.vn')->firstOrFail();
    expect($shop->lifecycle_state)->toBe('active')->and($shop->owner_user_id)->toBe($a->owner->id)
        ->and($blog->owner_user_id)->toBe($newOwner->id)->and($newOwner->realm)->toBe('portal')
        ->and(Website::query()->where('primary_domain', 'shop.anphat.vn')->value('status'))->toBe('ready')
        ->and(Website::query()->where('primary_domain', 'blog.anphat.vn')->value('php_version'))->toBe('8.3')
        ->and(Website::query()->where('primary_domain', 'shop.anphat.vn')->value('php_version'))->toBe('8.2')
        ->and(Database::query()->where('name', 'shopap_anphat')->value('status'))->toBe('ready')
        ->and(CronJob::query()->where('hosting_account_id', $shop->id)->value('enabled'))->toBeFalse();
    $items = collect($sa->get("/api/v1/admin/imports/{$imp->uuid}/items?sort=domain")->json('data'))->keyBy('domain');
    expect($items['shop.anphat.vn']['state'])->toBe('done')
        ->and($items['shop.anphat.vn']['result'])->toMatchArray(['hosting_account' => ['uuid' => $shop->uuid, 'username' => 'shopap'],
            'files' => 120, 'skipped' => 1, 'db_tables' => 12, 'db_rows_match' => true, 'error' => null])
        ->and($items['cu.anphat.vn']['state'])->toBe('skipped');
    assertMatchesContract(P12A, 'get', '/api/v1/admin/imports/{id}/items', 200, $sa->get("/api/v1/admin/imports/{$imp->uuid}/items"));
    // Chạy lại lượt đã xong → 409.
    expect(p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:run")->status())->toBe(409);

    // Cutover: tắt vhost nguồn của 2 site + xin chứng chỉ ACME cho site có SSL ở nguồn.
    $agent->calls = [];
    $c = p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:cutover");
    assertMatchesContract(P12A, 'post', '/api/v1/admin/imports/{id}:cutover', 202, $c);
    expect($agent->ops())->toBe(['import.cutover', 'cert.issue', 'nginx.vhost.apply'])
        ->and($call('import.cutover')['vhost_paths'])->toBe(['/www/server/panel/vhost/nginx/shop.anphat.vn.conf', '/www/server/panel/vhost/nginx/blog.anphat.vn.conf']);
    $imp->refresh();
    expect($imp->state)->toBe('cut_over')->and($imp->cutover_at)->not->toBeNull()
        ->and(Certificate::query()->where('status', 'ready')->count())->toBe(1)
        ->and(Website::query()->where('primary_domain', 'shop.anphat.vn')->value('ssl_mode'))->toBe('acme')
        ->and(ImportItem::query()->where('domain', 'shop.anphat.vn')->first()->result['certificate'])->toBe('acme');

    // Quay lại: bật lại vhost nguồn, account ITSO giữ nguyên.
    $agent->calls = [];
    $rb = p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:rollback");
    assertMatchesContract(P12A, 'post', '/api/v1/admin/imports/{id}:rollback', 202, $rb);
    expect($agent->ops())->toBe(['import.rollback'])->and($imp->refresh()->state)->toBe('rolled_back')
        ->and(HostingAccount::query()->whereIn('username', ['shopap', 'blogap'])->count())->toBe(2)
        ->and(AuditLog::query()->whereIn('action', ['import.run', 'import.cutover', 'import.rollback'])->count())->toBe(3);
    expect(p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:rollback")->status())->toBe(409);
    expect($errors)->toBe([]);
});

it('chạy: gói không cho phép phiên bản PHP nào đã cài trên server → 422 theo mục, chưa tạo account/job (tìm ra nhờ e2e 12.8)', function () {
    $errors = [];
    p12agent($errors);
    $a = new Actors($this);
    [$sa, $biz] = p12setup($a);
    $imp = p12scanned($a, $sa);
    $ids = p12items($imp);
    $sa->call('PUT', "/api/v1/admin/imports/{$imp->uuid}/plan", ['items' => [
        ['uuid' => $ids['shop.anphat.vn'], 'selected' => true, 'username' => 'shopap', 'package' => $biz->uuid, 'user' => $a->owner->uuid],
        ['uuid' => $ids['blog.anphat.vn'], 'selected' => false],
    ]])->assertOk();
    PhpVersion::query()->where('server_id', $a->server->id)->update(['status' => 'failed']);
    p12touch($a);
    $r = p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:run");
    expect($r->status())->toBe(422)->and($r->json('errors')['items.0.package'][0] ?? '')->toContain('không cho phép phiên bản PHP nào đã cài')
        ->and(Job::query()->where('type', 'import.run')->count())->toBe(0)
        ->and(HostingAccount::query()->where('username', 'shopap')->exists())->toBeFalse()
        ->and($imp->refresh()->state)->toBe('planned');
});

it('một account lỗi (copy) → partially_failed, mục lỗi có thông báo; cutover chỉ mục đã xong', function () {
    $errors = [];
    $agent = p12agent($errors, ['import.copy' => fn (array $e) => str_contains($e['params']['src'], 'blog')
        ? ['__error' => ['quota_exceeded', 'Vượt hạn mức dung lượng của account', false]]
        : ['files' => 3, 'bytes' => 1000, 'skipped' => 0, 'skipped_reasons' => []]]);
    $a = new Actors($this);
    [$sa, $biz] = p12setup($a);
    $imp = p12scanned($a, $sa);
    $ids = p12items($imp);
    $sa->call('PUT', "/api/v1/admin/imports/{$imp->uuid}/plan", ['items' => [
        ['uuid' => $ids['shop.anphat.vn'], 'selected' => true, 'username' => 'shopap', 'package' => $biz->uuid, 'user' => $a->owner->uuid],
        ['uuid' => $ids['blog.anphat.vn'], 'selected' => true, 'username' => 'blogap', 'package' => $biz->uuid, 'user' => $a->owner->uuid],
    ]])->assertOk();
    p12touch($a);
    p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:run")->assertStatus(202);
    $imp->refresh();
    $blog = ImportItem::query()->where('domain', 'blog.anphat.vn')->first();
    expect($imp->state)->toBe('partially_failed')->and($imp->error)->toContain('1 mục lỗi')
        ->and($blog->state)->toBe('failed')->and($blog->result['error'])->toContain('quota_exceeded')
        ->and(HostingAccount::query()->where('username', 'blogap')->value('lifecycle_state'))->toBe('failed')
        ->and(ImportItem::query()->where('domain', 'shop.anphat.vn')->value('state'))->toBe('done');

    $agent->calls = [];
    p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:cutover")->assertStatus(202);
    expect(collect($agent->calls)->firstWhere('op', 'import.cutover')['params']['vhost_paths'])
        ->toBe(['/www/server/panel/vhost/nginx/shop.anphat.vn.conf'])
        ->and($imp->refresh()->state)->toBe('cut_over');
    expect($errors)->toBe([]);
});

it('cutover lỗi (nginx -t) → giữ completed kèm lỗi, không chứng chỉ; xóa lượt không đụng account đã tạo', function () {
    $errors = [];
    p12agent($errors, ['import.cutover' => fn () => ['__error' => ['nginx_test_failed', 'nginx -t lỗi; đã hoàn tác', false]]]);
    $a = new Actors($this);
    [$sa, $biz] = p12setup($a);
    $imp = p12scanned($a, $sa);
    $ids = p12items($imp);
    $sa->call('PUT', "/api/v1/admin/imports/{$imp->uuid}/plan", ['items' => [
        ['uuid' => $ids['shop.anphat.vn'], 'selected' => true, 'username' => 'shopap', 'package' => $biz->uuid, 'user' => $a->owner->uuid],
        ['uuid' => $ids['blog.anphat.vn'], 'selected' => false],
    ]])->assertOk();
    p12touch($a);
    p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:run")->assertStatus(202);
    p8($sa, 'POST', "/api/v1/admin/imports/{$imp->uuid}:cutover")->assertStatus(202);
    $imp->refresh();
    expect($imp->state)->toBe('completed')->and($imp->error)->toContain('Cutover lỗi')
        ->and(Certificate::query()->count())->toBe(0);

    $d = $sa->delete("/api/v1/admin/imports/{$imp->uuid}");
    assertMatchesContract(P12A, 'delete', '/api/v1/admin/imports/{id}', 204, $d);
    expect(PanelImport::query()->count())->toBe(0)->and(ImportItem::query()->count())->toBe(0)
        ->and(HostingAccount::query()->where('username', 'shopap')->exists())->toBeTrue();
    assertMatchesContract(P12A, 'get', '/api/v1/admin/imports/{id}', 404, $sa->get("/api/v1/admin/imports/{$imp->uuid}"));
    expect($errors)->toBe([]);
});

it('quyền: chỉ SUPER_ADMIN; ADMIN 403, USER 401/403 ở admin và 404 ở portal; chạy cần step-up', function () {
    $errors = [];
    p12agent($errors);
    $a = new Actors($this);
    [$sa] = p12setup($a);
    $imp = p12scanned($a, $sa);
    $ad = $a->spa('AD_IN');
    assertMatchesContract(P12A, 'get', '/api/v1/admin/imports', 403, $ad->get('/api/v1/admin/imports'));
    expect(p8($ad, 'POST', '/api/v1/admin/imports', ['source' => 'aapanel', 'server' => $a->server->uuid])->status())->toBe(403)
        ->and($ad->get("/api/v1/admin/imports/{$imp->uuid}")->status())->toBe(403)
        ->and(p8($ad, 'POST', "/api/v1/admin/imports/{$imp->uuid}:run")->status())->toBe(403);
    $us = $a->spa('US_OWNER');
    expect($us->get('/api/v1/admin/imports')->status())->toBeIn([401, 403])
        ->and($us->get('/api/v1/portal/imports')->status())->toBe(404);

    // SA chưa step-up (phiên mới, chỉ đăng nhập) → 403 mfa_step_up_required.
    $fresh = $this->spa('admin');
    $fresh->login($a->sa)->assertOk();
    $this->travel(11)->minutes();
    $r = p8($fresh, 'POST', "/api/v1/admin/imports/{$imp->uuid}:run");
    expect($r->status())->toBe(403);
    expect(DB::table('jobs')->where('type', 'import.run')->count())->toBe(0);
});
