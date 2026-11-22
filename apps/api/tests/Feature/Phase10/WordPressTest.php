<?php

use App\Domain\WordPress\WordPressSecrets;
use App\Models\AuditLog;
use App\Models\BackupSnapshot;
use App\Models\Database;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\Notification;
use App\Models\Website;
use App\Models\WordPressComponent;
use App\Models\WordPressSite;
use App\Models\WordPressUpdate;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;
use Tests\Support\Spa;

require_once __DIR__.'/../Phase8/helpers.php';

// Prompt 10.6: Panel WordPress (D-99) — cài, quét, chi tiết, cập nhật an toàn (snapshot → rollback), staging, hardening,
// đổi mật khẩu admin, bảo trì, tự cập nhật theo cửa sổ giờ. Params/result mọi op được kiểm theo contracts/agent-ops.

const P10WA = 'itso-admin-v1.yaml';
const P10WP = 'itso-portal-v1.yaml';

function p10w(Spa $spa, string $method, string $uri, array $body = []): TestResponse
{
    return $spa->call($method, $uri, $body, ['Idempotency-Key' => (string) Str::uuid()]);
}

/** wp.info giả: core 6.6.2 → 6.7.1, một plugin lỗi thời, DB_NAME theo account. */
function p10winfo(string $dbName, array $over = []): array
{
    return $over + ['version' => '6.6.2', 'site_url' => 'https://anphat.vn', 'multisite' => false, 'maintenance' => false,
        'components' => [
            ['type' => 'core', 'slug' => null, 'name' => 'WordPress', 'version' => '6.6.2', 'update_version' => '6.7.1', 'active' => true],
            ['type' => 'plugin', 'slug' => 'wordpress-seo', 'name' => 'Yoast SEO', 'version' => '23.0', 'update_version' => '23.9', 'active' => true],
            ['type' => 'theme', 'slug' => 'astra', 'name' => 'Astra', 'version' => '4.8.0', 'update_version' => null, 'active' => true],
        ],
        'hardening' => ['file_edit_disabled' => false, 'xmlrpc_blocked' => false, 'php_in_uploads_blocked' => false,
            'wp_config_protected' => false, 'version_hidden' => false, 'salts_rotated' => false],
        'checksums_ok' => true, 'db_name' => $dbName];
}

/**
 * Agent giả cho WordPress: mọi op có handler đều được kiểm params/result theo contracts; op hạ tầng khác (provision
 * website) trả `{ok: true}`.
 *
 * @param  array<string, callable>  $over
 */
function p10wagent(array &$errors, string $dbName, array $over = []): FakeAgent
{
    $snap = fn () => bin2hex(random_bytes(8));
    $base = [
        'db.mysql.owner_ensure' => fn () => ['created' => true],
        'db.mysql.create' => fn () => ['created' => true],
        'db.mysql.user_ensure' => fn () => ['created' => true, 'changed' => true],
        'db.mysql.grant' => fn () => ['granted' => true],
        'wp.install' => fn () => ['version' => '6.6.2', 'installed' => true],
        'wp.info' => fn () => p10winfo($dbName),
        'wp.detect' => fn (array $e) => ['sites' => array_map(fn ($r) => ['path' => $r, 'version' => '6.5.5', 'multisite' => false], $e['params']['roots'])],
        'wp.update' => fn (array $e) => ['results' => array_map(fn ($c) => ['type' => $c['type'], 'slug' => $c['slug'] ?? null,
            'from_version' => '1.0', 'to_version' => '1.1', 'ok' => true, 'error' => null], $e['params']['components']),
            'checksums_ok' => true, 'http_status' => 200, 'snapshot_id' => $snap(), 'db_snapshot_id' => $snap(), 'rolled_back' => false, 'rollback_error' => null],
        'wp.clone' => fn () => ['cloned' => true, 'replaced' => 42],
        'wp.harden' => fn (array $e) => ['applied' => $e['params']['enable'], 'needs_vhost_reload' => true],
        'wp.admin_password' => fn () => ['changed' => true],
        'wp.maintenance' => fn (array $e) => ['enabled' => $e['params']['enabled']],
        'backup.repo.init' => fn () => ['initialized' => true, 'already_existed' => false],
        'backup.stats' => fn () => ['raw_size_bytes' => 5242880, 'restore_size_bytes' => 6291456, 'snapshots' => 2],
        'nginx.vhost.apply' => fn () => ['config_path' => '/etc/nginx/sites-enabled/x.conf', 'nginx_test' => 'ok', 'reloaded' => true, 'changed' => true],
    ];
    $handlers = [];
    foreach ($over + $base as $op => $h) {
        $handlers[$op] = function (array $env) use ($op, $h, &$errors) {
            if (($e = p8schema($op, $env['params'], 'params')) !== null) {
                $errors[] = $e;
            }
            $out = $h($env);
            if (! isset($out['__error']) && ($e = p8schema($op, $out, 'result')) !== null) {
                $errors[] = $e;
            }

            return $out;
        };
    }
    $handlers['*'] = fn () => ['ok' => true];

    return new FakeAgent($handlers);
}

function p10wwebsite(Actors $a, string $domain = 'anphat.vn'): Website
{
    return Website::query()->create(['hosting_account_id' => $a->account->id, 'server_id' => $a->server->id, 'primary_domain' => $domain,
        'type' => 'php', 'document_root' => 'public', 'php_version' => '8.3', 'status' => 'ready']);
}

/** Cài WordPress qua portal (chủ account); trả [site, response]. */
function p10winstall(Actors $a, Spa $spa, Website $w): array
{
    $r = p10w($spa, 'POST', '/api/v1/portal/wordpress/sites', ['website_uuid' => $w->uuid, 'title' => 'An Phát',
        'admin_username' => 'anphat_admin', 'admin_email' => 'admin@anphat.vn', 'locale' => 'vi']);

    return [WordPressSite::query()->where('website_id', $w->id)->first(), $r];
}

function p10wdest(Spa $sa): void
{
    $sa->post('/api/v1/admin/backup-destinations', ['name' => 'Local', 'type' => 'local', 'config' => ['path' => '/var/backups/itso']])->assertCreated();
}

it('USER cài WordPress: DB + user theo gói, mật khẩu admin trả một lần (không lọt DB/log), site sẵn sàng khớp contract', function () {
    $errors = [];
    $a = new Actors($this);
    $agent = p10wagent($errors, $a->account->username.'_wp');
    $w = p10wwebsite($a);
    $us = $a->spa('US_OWNER');

    [$wp, $r] = p10winstall($a, $us, $w);
    assertMatchesContract(P10WP, 'post', '/api/v1/portal/wordpress/sites', 202, $r);
    $secret = (string) $r->json('secret');
    expect(strlen($secret))->toBeGreaterThanOrEqual(16)->and($r->headers->get('Cache-Control'))->toContain('no-store')
        ->and($agent->ops())->toBe(['db.mysql.owner_ensure', 'db.mysql.create', 'db.mysql.user_ensure', 'db.mysql.grant', 'wp.install', 'wp.info']);
    $inst = collect($agent->calls)->firstWhere('op', 'wp.install')['params'];
    expect($inst['admin_password'])->toBe($secret)->and($inst['site']['path'])->toBe('sites/anphat.vn/public')
        ->and($inst['db']['name'])->toBe($a->account->username.'_wp');

    // Bí mật chỉ đi tới agent: không có trong bảng nào, tham chiếu cache đã xóa khi job xong.
    expect(p8leak($secret))->toBeNull()
        ->and(DB::table('notifications')->get()->contains(fn ($n) => str_contains(json_encode($n), $secret)))->toBeFalse();
    $raw = (string) json_encode(JobStep::query()->where('op', 'wp.install')->value('params_redacted'));
    expect(preg_match('/wp_password:([0-9a-f-]{36})/', $raw, $m))->toBe(1)->and(WordPressSecrets::get($m[1]))->toBeNull();

    $wp->refresh();
    expect($wp->state)->toBe('ok')->and($wp->version)->toBe('6.6.2')->and($wp->database_id)->not->toBeNull()
        ->and(Database::query()->whereKey($wp->database_id)->value('status'))->toBe('ready')
        ->and(WordPressComponent::query()->where('wordpress_site_id', $wp->id)->count())->toBe(3);

    $list = $us->get('/api/v1/portal/wordpress/sites');
    assertMatchesContract(P10WP, 'get', '/api/v1/portal/wordpress/sites', 200, $list);
    expect($list->json('data.0.plugins_outdated'))->toBe(1)->and($list->json('data.0.latest_version'))->toBe('6.7.1')
        ->and($list->json('data.0.state'))->toBe('ready');
    $show = $us->get("/api/v1/portal/wordpress/sites/{$wp->uuid}");
    assertMatchesContract(P10WP, 'get', '/api/v1/portal/wordpress/sites/{id}', 200, $show);
    expect(collect($show->json('data.components'))->firstWhere('slug', 'wordpress-seo')['latest_version'])->toBe('23.9');

    // Cài lần hai vào cùng website → 409; website không phải php → 422.
    expect(p10winstall($a, $us, $w)[1]->status())->toBe(409);
    expect(AuditLog::query()->where('action', 'wordpress.install')->exists())->toBeTrue()->and($errors)->toBe([]);
});

it('USER không thấy / không thao tác được site của account khác; ADMIN ngoài phạm vi → 404', function () {
    $errors = [];
    $a = new Actors($this);
    $agent = p10wagent($errors, $a->account->username.'_wp');
    $w = p10wwebsite($a);
    [$wp] = p10winstall($a, $a->spa('US_OWNER'), $w);
    $n = count($agent->calls);

    $other = $a->spa('US_OTHER');
    expect($other->get('/api/v1/portal/wordpress/sites')->json('data'))->toBe([]);
    foreach ([['GET', "/{$wp->uuid}"], ['GET', "/{$wp->uuid}/updates"], ['PATCH', "/{$wp->uuid}", ['auto_update' => 'all']],
        ['POST', "/{$wp->uuid}:update", ['core' => true]], ['POST', "/{$wp->uuid}:clone-staging", ['subdomain' => 'stg']],
        ['POST', "/{$wp->uuid}:harden", ['items' => ['file_edit_disabled'], 'enabled' => true]],
        ['POST', "/{$wp->uuid}:maintenance", ['enabled' => true]]] as $c) {
        expect(p10w($other, $c[0], '/api/v1/portal/wordpress/sites'.$c[1], $c[2] ?? [])->status())->toBe(404);
    }
    expect(p10w($other, 'POST', '/api/v1/portal/wordpress/sites', ['website_uuid' => $w->uuid, 'title' => 'X',
        'admin_username' => 'xadmin', 'admin_email' => 'x@x.vn', 'locale' => 'vi'])->status())->toBe(422);
    expect(p10w($a->spa('AD_OUT'), 'GET', "/api/v1/admin/wordpress/sites/{$wp->uuid}")->status())->toBe(404);
    $in = $a->spa('AD_IN')->get('/api/v1/admin/wordpress/sites');
    assertMatchesContract(P10WA, 'get', '/api/v1/admin/wordpress/sites', 200, $in);
    expect($in->json('data.0.uuid'))->toBe($wp->uuid)->and(count($agent->calls))->toBe($n)
        ->and(WordPressSite::query()->value('auto_update'))->not->toBe('all')->and($errors)->toBe([]);
});

it('cập nhật lỗi → agent khôi phục snapshot: lịch sử rolled_back, snapshot pre-wp-update, thông báo chủ account + người yêu cầu', function () {
    $errors = [];
    $a = new Actors($this);
    $db = $a->account->username.'_wp';
    $agent = p10wagent($errors, $db, ['wp.update' => fn (array $e) => ['results' => [
        ['type' => 'core', 'slug' => null, 'from_version' => '6.6.2', 'to_version' => '6.7.1', 'ok' => true, 'error' => null],
        ['type' => 'plugin', 'slug' => 'wordpress-seo', 'from_version' => '23.0', 'to_version' => '23.0', 'ok' => false, 'error' => 'Download failed.'],
    ], 'checksums_ok' => true, 'http_status' => 0, 'snapshot_id' => 'a1b2c3d4e5f60718', 'db_snapshot_id' => 'b1b2c3d4e5f60718',
        'rolled_back' => true, 'rollback_error' => null]]);
    $w = p10wwebsite($a);
    [$wp] = p10winstall($a, $a->spa('US_OWNER'), $w);
    $sa = $a->spa('SA');

    // Chưa có đích backup → 409: cập nhật luôn cần snapshot trước.
    expect(p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:update", ['core' => true])->json('code'))->toBe('precondition_failed');
    p10wdest($sa);
    expect(p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:update", [])->status())->toBe(422);
    $n = count($agent->calls);
    $r = p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:update", ['core' => true, 'plugins' => ['wordpress-seo']]);
    assertMatchesContract(P10WA, 'post', '/api/v1/admin/wordpress/sites/{id}:update', 202, $r);
    expect(array_slice($agent->ops(), $n))->toBe(['backup.repo.init', 'wp.update', 'backup.stats', 'wp.info']);
    $up = collect($agent->calls)->firstWhere('op', 'wp.update')['params'];
    expect($up['components'])->toEqual([['type' => 'core'], ['type' => 'plugin', 'slug' => 'wordpress-seo']])
        ->and($up['snapshot']['db'])->toEqual(['engine' => 'mariadb', 'name' => $db])
        ->and($up['snapshot']['tags'])->toBe(['account:'.$a->account->uuid, 'manual'])->and($up['minor_only'])->toBeFalse();

    $u = WordPressUpdate::query()->firstOrFail();
    expect($u->state)->toBe('rolled_back')->and($u->error)->toBe('Download failed.')
        ->and(collect($u->steps)->pluck('state', 'key')->all())->toBe(['snapshot' => 'done', 'maintenance' => 'done', 'update' => 'failed',
            'verify' => 'skipped', 'rollback' => 'done']);
    $snaps = BackupSnapshot::query()->orderBy('id')->get();
    expect($snaps->pluck('restic_snapshot_id')->all())->toBe(['a1b2c3d4e5f60718', 'b1b2c3d4e5f60718'])
        ->and($snaps[0]->tags)->toContain('pre-wp-update')->and($snaps[0]->scope_type)->toBe('website')
        ->and($snaps[1]->scope_type)->toBe('database')->and($snaps[1]->databases)->toBe([$db])
        ->and($u->snapshot_id)->toBe($snaps[0]->id);
    expect(WordPressSite::query()->value('state'))->toBe('ok');
    $notes = Notification::query()->where('type', 'wordpress.update_rolled_back')->pluck('user_id')->sort()->values()->all();
    expect($notes)->toBe(collect([$a->owner->id, $a->sa->id])->sort()->values()->all());

    $h = $sa->get("/api/v1/admin/wordpress/sites/{$wp->uuid}/updates");
    assertMatchesContract(P10WA, 'get', '/api/v1/admin/wordpress/sites/{id}/updates', 200, $h);
    expect($h->json('data.0.state'))->toBe('rolled_back')->and($h->json('data.0.snapshot_uuid'))->toBe($snaps[0]->uuid)
        ->and($h->json('data.0.items.1'))->toBe(['type' => 'plugin', 'slug' => 'wordpress-seo', 'from' => '23.0', 'to' => '23.0']);
    $site = $a->spa('US_OWNER')->get("/api/v1/portal/wordpress/sites/{$wp->uuid}");
    expect($site->json('data.site.last_update.state'))->toBe('rolled_back')->and($errors)->toBe([]);
});

it('cập nhật thành công: không thông báo; khôi phục cũng hỏng → failed, site lỗi, thông báo mức cao', function () {
    $errors = [];
    $a = new Actors($this);
    $fail = false;
    $agent = p10wagent($errors, $a->account->username.'_wp', ['wp.update' => function (array $e) use (&$fail) {
        return $fail ? ['__error' => ['wp_update_failed', 'Cập nhật lỗi và khôi phục snapshot cũng lỗi: restore failed']]
            : ['results' => [['type' => 'core', 'slug' => null, 'from_version' => '6.6.2', 'to_version' => '6.7.1', 'ok' => true, 'error' => null]],
                'checksums_ok' => true, 'http_status' => 200, 'snapshot_id' => 'c1b2c3d4e5f60718', 'db_snapshot_id' => null,
                'rolled_back' => false, 'rollback_error' => null];
    }]);
    [$wp] = p10winstall($a, $a->spa('US_OWNER'), p10wwebsite($a));
    $sa = $a->spa('SA');
    p10wdest($sa);
    p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:update", ['core' => true])->assertStatus(202);
    expect(WordPressUpdate::query()->value('state'))->toBe('succeeded')->and(Notification::query()->where('type', 'like', 'wordpress.%')->count())->toBe(0);

    $fail = true;
    p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:update", ['core' => true])->assertStatus(202);
    $u = WordPressUpdate::query()->orderByDesc('id')->firstOrFail();
    expect($u->state)->toBe('failed')->and($u->error)->toContain('khôi phục snapshot cũng lỗi')
        ->and(WordPressSite::query()->value('state'))->toBe('error')
        ->and(Notification::query()->where('type', 'wordpress.update_failed')->where('user_id', $a->owner->id)->value('data'))->toMatchArray(['severity' => 'high']);
    // Site lỗi: không cập nhật tiếp được cho tới khi kiểm tra lại.
    expect(p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:update", ['core' => true])->status())->toBe(409)->and($errors)->toBe([]);
});

it('staging: vượt giới hạn website của gói bị chặn; basic auth chưa hỗ trợ; trong giới hạn → website + DB mới, wp.clone noindex', function () {
    $errors = [];
    $a = new Actors($this);
    $agent = p10wagent($errors, $a->account->username.'_wp');
    [$wp] = p10winstall($a, $a->spa('US_OWNER'), p10wwebsite($a));
    $us = $a->spa('US_OWNER');
    $a->account->forceFill(['limits_override' => ['website_limit' => 1]])->save();
    $n = count($agent->calls);

    $r = p10w($us, 'POST', "/api/v1/portal/wordpress/sites/{$wp->uuid}:clone-staging", ['subdomain' => 'staging']);
    expect($r->status())->toBe(422)->and($r->json('code'))->toBe('quota_exceeded');
    expect(p10w($us, 'POST', "/api/v1/portal/wordpress/sites/{$wp->uuid}:clone-staging", ['subdomain' => 'staging', 'basic_auth' => true])->status())->toBe(422);
    expect(Website::query()->count())->toBe(1)->and(Job::query()->where('type', 'wordpress.clone_staging')->exists())->toBeFalse()
        ->and(count($agent->calls))->toBe($n);

    $a->account->forceFill(['limits_override' => []])->save();
    $ok = p10w($us, 'POST', "/api/v1/portal/wordpress/sites/{$wp->uuid}:clone-staging", ['subdomain' => 'staging']);
    assertMatchesContract(P10WP, 'post', '/api/v1/portal/wordpress/sites/{id}:clone-staging', 202, $ok);
    $c = collect($agent->calls)->firstWhere('op', 'wp.clone')['params'];
    expect($c['target']['path'])->toBe('sites/staging.anphat.vn/public')->and($c['noindex'])->toBeTrue()
        ->and($c['source_db'])->toBe($a->account->username.'_wp')->and($c['target_db']['name'])->toBe($a->account->username.'_stg');
    $stg = WordPressSite::query()->whereNotNull('staging_of_id')->with('website')->firstOrFail();
    expect($stg->state)->toBe('ok')->and($stg->website->status)->toBe('ready')->and($stg->auto_update)->toBe('off');
    $d = $us->get("/api/v1/portal/wordpress/sites/{$wp->uuid}");
    expect($d->json('data.staging.0.domain'))->toBe('staging.anphat.vn');
    // Không tạo staging từ staging.
    expect(p10w($us, 'POST', "/api/v1/portal/wordpress/sites/{$stg->uuid}:clone-staging", ['subdomain' => 'x'])->status())->toBe(409)
        ->and($errors)->toBe([]);
});

it('tự cập nhật chỉ chạy trong cửa sổ giờ, tối đa một lần mỗi 20 giờ, minor → --minor, tag auto', function () {
    $errors = [];
    $a = new Actors($this);
    $agent = p10wagent($errors, $a->account->username.'_wp');
    [$wp] = p10winstall($a, $a->spa('US_OWNER'), p10wwebsite($a));
    $sa = $a->spa('SA');
    p10wdest($sa);
    $p = p10w($sa, 'PATCH', "/api/v1/admin/wordpress/sites/{$wp->uuid}", ['auto_update' => 'minor', 'update_window' => '22:00-02:00']);
    assertMatchesContract(P10WA, 'patch', '/api/v1/admin/wordpress/sites/{id}', 200, $p);
    expect(p10w($sa, 'PATCH', "/api/v1/admin/wordpress/sites/{$wp->uuid}", ['update_window' => '2:00-5:00'])->status())->toBe(422);
    expect($sa->call('PATCH', "/api/v1/admin/wordpress/sites/{$wp->uuid}", ['auto_update' => 'all'], ['If-Match' => '"cu"', 'Idempotency-Key' => (string) Str::uuid()])->status())->toBe(412);

    $this->travelTo(Carbon::parse('2026-11-23 12:30:00'));
    $this->artisan('itso:wordpress-auto-update')->assertSuccessful();
    expect(Job::query()->where('type', 'wordpress.update')->count())->toBe(0);

    $this->travelTo(Carbon::parse('2026-11-24 01:05:00')); // qua nửa đêm, vẫn trong 22:00-02:00
    $this->artisan('itso:wordpress-auto-update')->assertSuccessful();
    expect(Job::query()->where('type', 'wordpress.update')->count())->toBe(1);
    $up = collect($agent->calls)->firstWhere('op', 'wp.update')['params'];
    expect($up['minor_only'])->toBeTrue()->and($up['snapshot']['tags'])->toContain('auto')
        ->and(collect($up['components'])->pluck('type')->all())->toBe(['core', 'plugin']);
    expect(WordPressUpdate::query()->value('trigger'))->toBe('auto')->and(WordPressUpdate::query()->value('requested_by_user_id'))->toBeNull();

    $this->travelTo(Carbon::parse('2026-11-24 01:30:00')); // trong cửa sổ nhưng chưa đủ 20 giờ → bỏ qua
    $this->artisan('itso:wordpress-auto-update')->assertSuccessful();
    expect(Job::query()->where('type', 'wordpress.update')->count())->toBe(1);
    $this->travelTo(Carbon::parse('2026-11-24 23:00:00'));
    $this->artisan('itso:wordpress-auto-update')->assertSuccessful();
    expect(Job::query()->where('type', 'wordpress.update')->count())->toBe(2);

    // Tắt tự cập nhật → không còn job (phiên mới: phiên cũ đã hết hạn sau hai ngày "du hành").
    p10w($a->spa('SA'), 'PATCH', "/api/v1/admin/wordpress/sites/{$wp->uuid}", ['auto_update' => 'off'])->assertOk();
    $this->travelTo(Carbon::parse('2026-11-26 23:00:00'));
    $this->artisan('itso:wordpress-auto-update')->assertSuccessful();
    expect(Job::query()->where('type', 'wordpress.update')->count())->toBe(2)->and($errors)->toBe([]);
});

it('quét, hardening (cờ vhost → nginx.vhost.apply), bảo trì, đổi mật khẩu admin (step-up, không lưu mật khẩu)', function () {
    $errors = [];
    $a = new Actors($this);
    $agent = p10wagent($errors, $a->account->username.'_wp');
    $w = p10wwebsite($a);
    p10wwebsite($a, 'blog.vn');
    $sa = $a->spa('SA');

    $s = p10w($sa, 'POST', '/api/v1/admin/wordpress/sites:scan');
    assertMatchesContract(P10WA, 'post', '/api/v1/admin/wordpress/sites:scan', 202, $s);
    expect(collect($agent->calls)->firstWhere('op', 'wp.detect')['params']['roots'])->toBe(['sites/anphat.vn/public', 'sites/blog.vn/public'])
        ->and(WordPressSite::query()->count())->toBe(2)->and(WordPressSite::query()->value('admin_user'))->toBeNull();
    $wp = WordPressSite::query()->where('website_id', $w->id)->firstOrFail();

    $h = p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:harden", ['items' => ['xmlrpc_blocked', 'file_edit_disabled'], 'enabled' => true]);
    assertMatchesContract(P10WA, 'post', '/api/v1/admin/wordpress/sites/{id}:harden', 202, $h);
    $vh = collect($agent->calls)->firstWhere('op', 'nginx.vhost.apply')['params'];
    expect($vh['wp_hardening'])->toBe(['xmlrpc_blocked' => true, 'php_in_uploads_blocked' => false])
        ->and(collect($agent->calls)->firstWhere('op', 'wp.harden')['params']['enable'])->toBe(['xmlrpc_blocked', 'file_edit_disabled']);
    expect(p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:harden", ['items' => ['salts_rotated'], 'enabled' => false])->status())->toBe(422);

    $m = p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:maintenance", ['enabled' => true]);
    assertMatchesContract(P10WA, 'post', '/api/v1/admin/wordpress/sites/{id}:maintenance', 202, $m);
    expect($wp->refresh()->maintenance)->toBeTrue();

    // Site phát hiện qua quét: chưa biết user admin → 409; biết rồi → wp.admin_password nhận mật khẩu thật, DB không lưu.
    $pass = 'N3w-Strong.Pass2026';
    expect(p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:admin-password", ['password' => $pass])->status())->toBe(409);
    $wp->forceFill(['admin_user' => 'anphat_admin'])->save();
    expect(p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:admin-password", ['password' => 'ngan'])->status())->toBe(422);
    $p = p10w($sa, 'POST', "/api/v1/admin/wordpress/sites/{$wp->uuid}:admin-password", ['password' => $pass]);
    assertMatchesContract(P10WA, 'post', '/api/v1/admin/wordpress/sites/{id}:admin-password', 202, $p);
    expect(collect($agent->calls)->firstWhere('op', 'wp.admin_password')['params'])->toMatchArray(['user' => 'anphat_admin', 'password' => $pass])
        ->and($p->json('secret'))->toBeNull()->and(p8leak($pass))->toBeNull()->and($errors)->toBe([]);
});
