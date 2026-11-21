<?php

use App\Domain\Hosting\AccountLifecycle;
use App\Domain\Hosting\QuotaService;
use App\Domain\Hosting\UidAllocator;
use App\Exceptions\ApiProblem;
use App\Models\AccountLifecycleEvent;
use App\Models\AccountUsageSnapshot;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\HostingPackageVersion;
use App\Models\Job;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\Actors;
use Tests\Support\FakeAgent;
use Tests\Support\Spa;

const HA = 'itso-admin-v1.yaml';
const HP = 'itso-portal-v1.yaml';

function idem(Spa $spa, string $uri, array $body = []): TestResponse
{
    return $spa->call('POST', $uri, $body, ['Idempotency-Key' => (string) Str::uuid()]);
}

function okAgent(): FakeAgent
{
    return new FakeAgent(['*' => fn () => ['ok' => true]]);
}

it('gói: tạo, sửa limits tạo phiên bản mới bất biến, versions, xóa khi còn account bị 409; khớp hợp đồng', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $c = $sa->post('/api/v1/admin/hosting-packages', ['code' => 'basic', 'name' => 'Cơ bản', 'description' => null, 'limits' => limits()]);
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-packages', 201, $c);
    $id = $c->json('data.uuid');
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-packages', 409, $sa->post('/api/v1/admin/hosting-packages',
        ['code' => 'basic', 'name' => 'Trùng', 'limits' => limits()]));
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-packages', 422, $sa->post('/api/v1/admin/hosting-packages',
        ['code' => 'x2', 'name' => 'Sai', 'limits' => limits(['retention_days_after_terminate' => 7])]));

    $g = $sa->get("/api/v1/admin/hosting-packages/$id");
    assertMatchesContract(HA, 'get', '/api/v1/admin/hosting-packages/{id}', 200, $g);
    $etag = $g->headers->get('ETag');
    $same = $sa->call('PATCH', "/api/v1/admin/hosting-packages/$id", ['limits' => limits(), 'name' => 'Cơ bản 1'], ['If-Match' => $etag]);
    assertMatchesContract(HA, 'patch', '/api/v1/admin/hosting-packages/{id}', 200, $same);
    expect($same->json('data.current_version'))->toBe(1);
    expect($sa->call('PATCH', "/api/v1/admin/hosting-packages/$id", ['name' => 'x'], ['If-Match' => $etag])->status())->toBe(412);
    $v2 = $sa->call('PATCH', "/api/v1/admin/hosting-packages/$id", ['limits' => limits(['disk_mb' => 20480])]);
    expect($v2->json('data'))->toMatchArray(['current_version' => 2])->and($v2->json('data.limits.disk_mb'))->toBe(20480);
    $vers = $sa->get("/api/v1/admin/hosting-packages/$id/versions");
    assertMatchesContract(HA, 'get', '/api/v1/admin/hosting-packages/{id}/versions', 200, $vers);
    expect(collect($vers->json('data'))->pluck('limits.disk_mb', 'version')->all())->toBe([2 => 20480, 1 => 10240]);
    // Phiên bản bất biến ở tầng DB.
    expect(fn () => DB::transaction(fn () => HostingPackageVersion::query()->where('version', 1)->update(['disk_mb' => 1])))
        ->toThrow(Exception::class);

    assertMatchesContract(HA, 'get', '/api/v1/admin/hosting-packages', 200, $sa->get('/api/v1/admin/hosting-packages', ['q' => 'basic']));
    $used = HostingPackage::query()->findOrFail(HostingPackageVersion::query()->findOrFail($a->account->package_version_id)->package_id);
    assertMatchesContract(HA, 'delete', '/api/v1/admin/hosting-packages/{id}', 409, $sa->delete("/api/v1/admin/hosting-packages/{$used->uuid}"));
    assertMatchesContract(HA, 'delete', '/api/v1/admin/hosting-packages/{id}', 204, $sa->delete("/api/v1/admin/hosting-packages/$id"));
    assertMatchesContract(HA, 'get', '/api/v1/admin/hosting-packages/{id}', 404, $sa->get("/api/v1/admin/hosting-packages/$id"));
    expect($a->spa('AD_IN')->post('/api/v1/admin/hosting-packages', ['code' => 'adm', 'name' => 'A', 'limits' => limits()])->status())->toBe(403);
});

it('tạo account: job account.ensure + quota.apply với fake agent → active; UID cấp tuần tự, lifecycle events', function () {
    $agent = okAgent();
    $a = new Actors($this);
    $pkg = HostingPackage::factory()->create();
    $in = $a->spa('AD_IN');
    $r = idem($in, '/api/v1/admin/hosting-accounts', ['owner_user_uuid' => $a->owner->uuid, 'package_uuid' => $pkg->uuid,
        'server_uuid' => $a->server->uuid, 'username' => 'anphat', 'primary_domain' => null, 'limits_override' => ['disk_mb' => 5000]]);
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts', 202, $r);
    expect($r->json('job.type'))->toBe('hosting_account.create')->and($r->json('resource.type'))->toBe('hosting_account');
    $acc = HostingAccount::query()->where('uuid', $r->json('resource.uuid'))->firstOrFail();
    expect($acc)->lifecycle_state->toBe('active')->status->toBe('ready')->observed_version->toBe($acc->spec_version)
        ->and($acc->uid)->toBeGreaterThan($a->account->uid > 20000 ? 19999 : 0)
        ->and($agent->ops())->toBe(['account.ensure', 'quota.apply'])
        ->and($agent->calls[0]['params'])->toMatchArray(['home_path' => '/home/anphat', 'shell' => '/usr/sbin/nologin'])
        ->and($agent->calls[0]['params']['limits']['disk_mb'])->toBe(5000)
        ->and(AccountLifecycleEvent::query()->where('hosting_account_id', $acc->id)->orderBy('id')->pluck('to_state')->all())
        ->toBe(['provisioning', 'active']);

    $show = $in->get("/api/v1/admin/hosting-accounts/{$acc->uuid}");
    assertMatchesContract(HA, 'get', '/api/v1/admin/hosting-accounts/{id}', 200, $show);
    expect($show->json('data.usage.disk_mb'))->toBe(['used' => 0, 'limit' => 5000]);
    assertMatchesContract(HA, 'get', '/api/v1/admin/hosting-accounts', 200, $in->get('/api/v1/admin/hosting-accounts', ['filter[lifecycle_state]' => 'active']));
    assertMatchesContract(HA, 'get', '/api/v1/admin/hosting-accounts/{id}/features', 200, $in->get("/api/v1/admin/hosting-accounts/{$acc->uuid}/features"));
    assertMatchesContract(HA, 'get', '/api/v1/admin/hosting-accounts/{id}/usage', 200, $in->get("/api/v1/admin/hosting-accounts/{$acc->uuid}/usage"));
    assertMatchesContract(HA, 'get', '/api/v1/admin/hosting-accounts/{id}/lifecycle-events', 200,
        $in->get("/api/v1/admin/hosting-accounts/{$acc->uuid}/lifecycle-events"));

    $dup = idem($in, '/api/v1/admin/hosting-accounts', ['owner_user_uuid' => $a->owner->uuid, 'package_uuid' => $pkg->uuid,
        'server_uuid' => $a->server->uuid, 'username' => 'anphat']);
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts', 409, $dup);
    foreach (['root', 'Ab', '9abc', 'support'] as $bad) {
        expect(idem($in, '/api/v1/admin/hosting-accounts', ['owner_user_uuid' => $a->owner->uuid, 'package_uuid' => $pkg->uuid,
            'server_uuid' => $a->server->uuid, 'username' => $bad])->status())->toBe(422, $bad);
    }
    // Server ngoài phạm vi / chủ không phải USER Portal / server không nhận account mới.
    expect(idem($a->spa('AD_OUT'), '/api/v1/admin/hosting-accounts', ['owner_user_uuid' => $a->owner->uuid, 'package_uuid' => $pkg->uuid,
        'server_uuid' => $a->server->uuid, 'username' => 'khac'])->status())->toBe(422);
    $a->server->forceFill(['accepting_new_accounts' => false])->save();
    $nr = idem($in, '/api/v1/admin/hosting-accounts', ['owner_user_uuid' => $a->owner->uuid, 'package_uuid' => $pkg->uuid,
        'server_uuid' => $a->server->uuid, 'username' => 'moimoi']);
    expect($nr->status())->toBe(422)->and($nr->json('code'))->toBe('server_not_accepting');
});

it('tạo account lỗi agent → failed, retry job → active', function () {
    $fail = true;
    new FakeAgent(['account.ensure' => function () use (&$fail) {
        return $fail ? ['__error' => ['invalid_params', 'home sai', false]] : ['created' => true, 'uid' => 20001];
    }, '*' => fn () => ['ok' => true]]);
    $a = new Actors($this);
    $pkg = HostingPackage::factory()->create();
    $sa = $a->spa('SA');
    $r = idem($sa, '/api/v1/admin/hosting-accounts', ['owner_user_uuid' => $a->owner->uuid, 'package_uuid' => $pkg->uuid,
        'server_uuid' => $a->server->uuid, 'username' => 'loi']);
    $acc = HostingAccount::query()->where('uuid', $r->json('resource.uuid'))->firstOrFail();
    expect($acc)->lifecycle_state->toBe('failed')->status->toBe('failed');
    $fail = false;
    idem($sa, '/api/v1/admin/jobs/'.$r->json('job.uuid').':retry')->assertStatus(202);
    expect($acc->refresh())->lifecycle_state->toBe('active')->status->toBe('ready')
        ->and(AccountLifecycleEvent::query()->where('hosting_account_id', $acc->id)->orderBy('id')->pluck('to_state')->all())
        ->toBe(['provisioning', 'failed', 'active']);
});

it('máy trạng thái: suspend/unsuspend/terminate/khôi phục; chuyển không hợp lệ 409; account bận 409', function () {
    $agent = okAgent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $u = "/api/v1/admin/hosting-accounts/{$a->account->uuid}";

    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:unsuspend', 409, idem($sa, "$u:unsuspend"));
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:suspend', 422, idem($sa, "$u:suspend", ['reason' => 'x']));
    $s = idem($sa, "$u:suspend", ['reason' => 'Nhiễm mã độc, chờ làm sạch']);
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:suspend', 202, $s);
    expect($a->account->refresh())->lifecycle_state->toBe('suspended')->status->toBe('suspended')
        ->suspended_reason->toBe('Nhiễm mã độc, chờ làm sạch');
    expect(idem($sa, "$u:suspend", ['reason' => 'Lần hai nữa'])->json('code'))->toBe('invalid_state_transition');
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:unsuspend', 202, idem($sa, "$u:unsuspend"));
    expect($a->account->refresh())->lifecycle_state->toBe('active')->suspended_reason->toBeNull();

    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:terminate', 422,
        idem($sa, "$u:terminate", ['reason' => 'Dự án kết thúc', 'confirm_username' => 'khac']));
    $t = idem($sa, "$u:terminate", ['reason' => 'Dự án kết thúc', 'confirm_username' => $a->account->username]);
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:terminate', 202, $t);
    $acc = $a->account->refresh();
    expect($acc->lifecycle_state)->toBe('terminated')
        ->and((int) round($acc->terminated_at->diffInDays($acc->purge_after)))->toBe(30);
    $r = idem($sa, "$u:migrate", ['target_server_uuid' => (string) Str::uuid(), 'strategy' => 'live_sync']);
    expect($r->json('code'))->toBe('validation_failed'); // server đích không tồn tại (luồng đủ ở tests/Feature/Phase9)
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:migrate', 422, $r);
    // Purge (Phase 8): cần đích backup cho backup cuối; xác nhận cần biên bản. Chi tiết ở tests/Feature/Phase8.
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:schedule-purge', 409, idem($sa, "$u:schedule-purge", []));
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:confirm-purge', 422, idem($sa, "$u:confirm-purge", []));
    expect(idem($sa, "$u:suspend", ['reason' => 'Không được nữa'])->status())->toBe(409);
    // Khôi phục trong thời gian giữ.
    expect(idem($sa, "$u:unsuspend")->status())->toBe(202)->and($acc->refresh())->lifecycle_state->toBe('active')
        ->terminated_at->toBeNull()->purge_after->toBeNull();
    // Quá hạn giữ thì không khôi phục.
    idem($sa, "$u:terminate", ['reason' => 'Kết thúc lần 2', 'confirm_username' => $acc->username])->assertStatus(202);
    $this->travel(31)->days();
    expect(idem($a->spa('SA'), "$u:unsuspend")->status())->toBe(409);
    expect(AccountLifecycleEvent::query()->where('hosting_account_id', $acc->id)->orderBy('id')->pluck('to_state')->all())
        ->toBe(['suspended', 'active', 'terminated', 'active', 'terminated'])
        ->and($agent->ops())->toBe(['account.suspend', 'account.unsuspend', 'account.suspend', 'account.unsuspend', 'account.suspend']);
});

it('account đang có job chưa xong → 409 resource_locked; terminate cần quyền + step-up', function () {
    Queue::fake();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $u = "/api/v1/admin/hosting-accounts/{$a->account->uuid}";
    idem($sa, "$u:suspend", ['reason' => 'Tạm ngưng kiểm tra'])->assertStatus(202);
    expect($a->account->refresh()->status)->toBe('ready');
    $locked = idem($sa, "$u:unsuspend");
    expect($locked->status())->toBe(409)->and($locked->json('code'))->toBe('resource_locked');
    expect(idem($a->spa('AD_IN'), "$u:terminate", ['reason' => 'Không có quyền', 'confirm_username' => $a->account->username])->status())->toBe(403);
});

it('máy trạng thái (unit): chỉ chuyển hợp lệ theo bảng FROM', function (string $action, string $state, bool $ok) {
    expect(AccountLifecycle::allows($action, $state))->toBe($ok);
})->with([
    ['suspend', 'active', true], ['suspend', 'suspended', false], ['suspend', 'terminated', false], ['suspend', 'provisioning', false],
    ['unsuspend', 'suspended', true], ['unsuspend', 'active', false], ['restore', 'terminated', true], ['restore', 'purged', false],
    ['terminate', 'active', true], ['terminate', 'suspended', true], ['terminate', 'failed', true], ['terminate', 'terminated', false],
    ['terminate', 'purged', false], ['change_package', 'active', true], ['change_package', 'terminated', false],
]);

it('đổi gói + quota: vượt giới hạn → 422 quota_exceeded; chuyển account sang phiên bản mới qua job', function () {
    $agent = okAgent();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $u = "/api/v1/admin/hosting-accounts/{$a->account->uuid}";
    AccountUsageSnapshot::query()->create(['hosting_account_id' => $a->account->id, 'disk_mb' => 8000, 'inode_count' => 1000,
        'mem_peak_mb' => 0, 'at' => now()]);
    $small = $sa->post('/api/v1/admin/hosting-packages', ['code' => 'nho', 'name' => 'Nhỏ', 'limits' => limits(['disk_mb' => 5000])])->json('data.uuid');
    $big = $sa->post('/api/v1/admin/hosting-packages', ['code' => 'lon', 'name' => 'Lớn', 'limits' => limits(['disk_mb' => 50000])])->json('data.uuid');
    $q = idem($sa, "$u:change-package", ['package_uuid' => $small, 'version' => null, 'reason' => 'Giảm gói']);
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:change-package', 422, $q);
    expect($q->json('code'))->toBe('quota_exceeded');
    $ok = idem($sa, "$u:change-package", ['package_uuid' => $big, 'reason' => 'Nâng gói']);
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-accounts/{id}:change-package', 202, $ok);
    expect($sa->get($u)->json('data.package'))->toMatchArray(['code' => 'lon', 'version' => 1])
        ->and($agent->calls[0]['params']['limits']['disk_mb'])->toBe(50000);
    // Giảm override dưới mức đang dùng → 422.
    $p = $sa->call('PATCH', $u, ['limits_override' => ['disk_mb' => 100]]);
    assertMatchesContract(HA, 'patch', '/api/v1/admin/hosting-accounts/{id}', 422, $p);
    $p2 = $sa->call('PATCH', $u, ['limits_override' => ['disk_mb' => 9000], 'legal_hold' => true]);
    assertMatchesContract(HA, 'patch', '/api/v1/admin/hosting-accounts/{id}', 200, $p2);
    expect($p2->json('data'))->toMatchArray(['legal_hold' => true])->and($p2->json('data.usage.disk_mb.limit'))->toBe(9000)
        ->and($agent->ops())->toBe(['quota.apply', 'quota.apply']);
    expect($a->spa('AD_IN')->call('PATCH', $u, ['legal_hold' => false])->status())->toBe(403);

    // Sửa limits gói lớn → v2; migrate-accounts chuyển account v1 → v2.
    $sa->call('PATCH', "/api/v1/admin/hosting-packages/$big", ['limits' => limits(['disk_mb' => 60000])])->assertOk();
    expect($sa->get($u)->json('data.package.version'))->toBe(1);
    $m = idem($sa, "/api/v1/admin/hosting-packages/$big/versions/1:migrate-accounts");
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-packages/{id}/versions/{version}:migrate-accounts', 202, $m);
    expect($sa->get($u)->json('data'))->package->version->toBe(2)->and($sa->get($u)->json('data.usage.disk_mb.limit'))->toBe(9000)
        ->and(Job::query()->where('uuid', $m->json('job.uuid'))->value('state'))->toBe('succeeded');
    assertMatchesContract(HA, 'post', '/api/v1/admin/hosting-packages/{id}/versions/{version}:migrate-accounts', 422,
        idem($sa, "/api/v1/admin/hosting-packages/$big/versions/2:migrate-accounts"));
});

it('QuotaService::ensureCanAdd ném 422 quota_exceeded khi vượt', function () {
    $a = new Actors($this);
    $a->account->limits_override = ['website_limit' => 0];
    $a->account->save();
    try {
        app(QuotaService::class)->ensureCanAdd($a->account, 'websites');
        $this->fail('phải ném');
    } catch (ApiProblem $e) {
        expect($e->status)->toBe(422)->and($e->problemCode)->toBe('quota_exceeded');
    }
    $a->account->limits_override = ['website_limit' => 1];
    app(QuotaService::class)->ensureCanAdd($a->account, 'websites');
    expect(true)->toBeTrue();
});

it('UID không tái dùng trong 90 ngày', function () {
    $a = new Actors($this);
    $alloc = app(UidAllocator::class);
    $sid = $a->server->id;
    $u1 = DB::transaction(fn () => $alloc->allocate($sid));
    $u2 = DB::transaction(fn () => $alloc->allocate($sid));
    expect($u2)->toBe($u1 + 1);
    $alloc->release($sid, $u1);
    $this->travel(89)->days();
    expect(DB::transaction(fn () => $alloc->allocate($sid)))->toBe($u2 + 1);
    $this->travel(2)->days();
    expect(DB::transaction(fn () => $alloc->allocate($sid)))->toBe($u1);
});

it('Portal: chỉ account của mình (người khác 404), overview, profile; khớp hợp đồng', function () {
    $a = new Actors($this);
    $other = HostingAccount::query()->where('owner_user_id', $a->otherUser->id)->firstOrFail();
    $po = $a->spa('US_OWNER');
    $list = $po->get('/api/v1/portal/hosting-accounts');
    assertMatchesContract(HP, 'get', '/api/v1/portal/hosting-accounts', 200, $list);
    expect(collect($list->json('data'))->pluck('uuid')->all())->toBe([$a->account->uuid]);
    assertMatchesContract(HP, 'get', '/api/v1/portal/hosting-accounts/{id}', 200, $po->get("/api/v1/portal/hosting-accounts/{$a->account->uuid}"));
    assertMatchesContract(HP, 'get', '/api/v1/portal/hosting-accounts/{id}/features', 200, $po->get("/api/v1/portal/hosting-accounts/{$a->account->uuid}/features"));
    assertMatchesContract(HP, 'get', '/api/v1/portal/hosting-accounts/{id}/usage', 200, $po->get("/api/v1/portal/hosting-accounts/{$a->account->uuid}/usage"));
    foreach (['', '/features', '/usage'] as $sfx) {
        assertMatchesContract(HP, 'get', "/api/v1/portal/hosting-accounts/{id}$sfx", 404, $po->get("/api/v1/portal/hosting-accounts/{$other->uuid}$sfx"));
    }
    $ov = $po->get('/api/v1/portal/overview');
    assertMatchesContract(HP, 'get', '/api/v1/portal/overview', 200, $ov);
    expect(collect($ov->json('data.accounts'))->pluck('hosting_account.uuid')->all())->toBe([$a->account->uuid]);

    $pr = $po->get('/api/v1/portal/profile');
    assertMatchesContract(HP, 'get', '/api/v1/portal/profile', 200, $pr);
    $pp = $po->call('PATCH', '/api/v1/portal/profile', ['locale' => 'en', 'name' => 'Tên mới'], ['If-Match' => $pr->headers->get('ETag')]);
    assertMatchesContract(HP, 'patch', '/api/v1/portal/profile', 200, $pp);
    expect($pp->json('data'))->toMatchArray(['locale' => 'en', 'name' => 'Tên mới']);
    expect($po->call('PATCH', '/api/v1/portal/profile', ['email' => 'x@y.vn'])->status())->toBe(422);
    // USER không gọi được Admin API account.
    expect($po->get("/api/v1/admin/hosting-accounts/{$a->account->uuid}")->status())->toBe(401);
});

it('itso:usage-refresh ghi mức dùng từ quota.report; usage API trả số đo', function () {
    $a = new Actors($this);
    new FakeAgent(['quota.report' => fn (array $env) => ['usage' => array_map(fn (array $acc) => ['username' => $acc['username'],
        'disk_mb' => 1234, 'inodes' => 56, 'cpu_pct' => 1.5, 'ram_mb' => 64], $env['params']['accounts'])]]);
    $this->artisan('itso:usage-refresh')->assertSuccessful();
    $r = $a->spa('US_OWNER')->get("/api/v1/portal/hosting-accounts/{$a->account->uuid}/usage");
    expect($r->json('data.disk_mb.used'))->toBe(1234)->and($r->json('data.inodes.used'))->toBe(56)->and($r->json('data.ram_mb.used'))->toBe(64);
});
