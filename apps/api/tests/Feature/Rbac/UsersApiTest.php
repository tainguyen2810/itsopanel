<?php

use App\Auth\ApiTokenAuth;
use App\Domain\Audit\AuditLogger;
use App\Mail\PasswordResetMail;
use App\Models\AuditLog;
use App\Models\ImpersonationSession;
use App\Models\MfaCredential;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Tests\Support\Actors;

const AU = 'itso-admin-v1.yaml';
const PO = 'itso-portal-v1.yaml';

it('mọi endpoint users/roles/api-tokens trả đúng schema OpenAPI', function () {
    Mail::fake();
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $o = $a->owner->uuid;

    assertMatchesContract(AU, 'get', '/api/v1/admin/users', 200, $sa->get('/api/v1/admin/users', ['filter[realm]' => 'portal', 'q' => 'chu', 'sort' => 'name']));
    assertMatchesContract(AU, 'get', '/api/v1/admin/users/{id}', 200, $sa->get("/api/v1/admin/users/$o"));
    assertMatchesContract(AU, 'patch', '/api/v1/admin/users/{id}', 200, $sa->call('PATCH', "/api/v1/admin/users/$o", ['locale' => 'en']));
    assertMatchesContract(AU, 'post', '/api/v1/admin/users/{id}:lock', 200, $sa->post("/api/v1/admin/users/$o:lock"));
    assertMatchesContract(AU, 'post', '/api/v1/admin/users/{id}:unlock', 200, $sa->post("/api/v1/admin/users/$o:unlock"));
    assertMatchesContract(AU, 'post', '/api/v1/admin/users/{id}:reset-mfa', 200, $sa->post("/api/v1/admin/users/$o:reset-mfa"));
    assertMatchesContract(AU, 'get', '/api/v1/admin/users/{id}/scopes', 200, $sa->get("/api/v1/admin/users/{$a->adminIn->uuid}/scopes"));
    assertMatchesContract(AU, 'put', '/api/v1/admin/users/{id}/scopes', 200, $sa->call('PUT', "/api/v1/admin/users/{$a->adminOut->uuid}/scopes",
        ['scopes' => [['scope_type' => 'hosting_account', 'uuid' => $a->account->uuid]]]));
    assertMatchesContract(AU, 'post', '/api/v1/admin/users', 201, $sa->post('/api/v1/admin/users',
        ['realm' => 'portal', 'name' => 'Khach Moi', 'email' => 'moi@example.vn', 'role' => 'USER', 'locale' => 'en', 'send_invite' => true]));
    assertMatchesContract(AU, 'post', '/api/v1/admin/users', 409, $sa->post('/api/v1/admin/users',
        ['realm' => 'portal', 'name' => 'Trung', 'email' => 'MOI@example.vn', 'role' => 'USER']));
    assertMatchesContract(AU, 'post', '/api/v1/admin/users', 422, $sa->post('/api/v1/admin/users',
        ['realm' => 'portal', 'name' => 'Sai', 'email' => 'sai@example.vn', 'role' => 'ADMIN']));
    assertMatchesContract(AU, 'get', '/api/v1/admin/users/{id}', 404, $sa->get('/api/v1/admin/users/00000000-0000-4000-8000-000000000000'));

    $roles = $sa->get('/api/v1/admin/roles');
    assertMatchesContract(AU, 'get', '/api/v1/admin/roles', 200, $roles);
    expect(collect($roles->json('data'))->pluck('permissions', 'key')->all())
        ->toMatchArray(['SUPER_ADMIN' => ['*'], 'USER' => ['own.*']]);

    $created = $sa->post('/api/v1/admin/api-tokens', ['name' => 'ci', 'scopes' => ['users:read'], 'expires_at' => now()->addMonth()->toIso8601String()]);
    assertMatchesContract(AU, 'post', '/api/v1/admin/api-tokens', 201, $created);
    expect($created->json('data.secret'))->toStartWith(ApiTokenAuth::PREFIX);
    $list = $sa->get('/api/v1/admin/api-tokens');
    assertMatchesContract(AU, 'get', '/api/v1/admin/api-tokens', 200, $list);
    $tid = $list->json('data.0.uuid');
    assertMatchesContract(AU, 'post', '/api/v1/admin/api-tokens', 409, $sa->post('/api/v1/admin/api-tokens',
        ['name' => 'ci', 'scopes' => ['users:read'], 'expires_at' => now()->addMonth()->toIso8601String()]));
    assertMatchesContract(AU, 'delete', '/api/v1/admin/api-tokens/{id}', 204, $sa->delete("/api/v1/admin/api-tokens/$tid"));
    assertMatchesContract(AU, 'delete', '/api/v1/admin/api-tokens/{id}', 404, $sa->delete("/api/v1/admin/api-tokens/$tid"));
});

it('token tạo qua API dùng được với scope của nó', function () {
    $a = new Actors($this);
    $secret = $a->spa('SA')->post('/api/v1/admin/api-tokens', ['name' => 'doc-user', 'scopes' => ['users:read'],
        'expires_at' => now()->addDay()->toIso8601String()])->json('data.secret');
    $this->withToken($secret)->getJson('/api/v1/admin/users')->assertOk();
    $this->withToken($secret)->postJson('/api/v1/admin/users/'.$a->owner->uuid.':lock')->assertStatus(403);
});

it('mời user mới: gửi link đặt mật khẩu 72 giờ; user chưa có mật khẩu dùng được', function () {
    Mail::fake();
    $a = new Actors($this);
    $a->spa('AD_IN')->post('/api/v1/admin/users', ['realm' => 'portal', 'name' => 'Moi', 'email' => 'moi@example.vn',
        'role' => 'USER', 'send_invite' => true])->assertCreated();
    Mail::assertSent(PasswordResetMail::class, fn (PasswordResetMail $m) => $m->hasTo('moi@example.vn') && $m->minutes === 72 * 60);
    $u = User::query()->where('email', 'moi@example.vn')->firstOrFail();
    expect($u->created_by_user_id)->toBe($a->adminIn->id)->and($u->roleKey())->toBe('USER');
    $this->spa()->login($u, 'password-dev-only')->assertStatus(422);
});

it('luôn còn ít nhất một SUPER_ADMIN: không khóa / hạ vai trò SA cuối cùng; không tự khóa', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    expect($sa->post("/api/v1/admin/users/{$a->sa->uuid}:lock")->json('code'))->toBe('conflict');
    $sa2 = User::factory()->superAdmin()->create();
    $sa->post("/api/v1/admin/users/{$sa2->uuid}:lock")->assertOk();
    $res = $sa->call('PATCH', "/api/v1/admin/users/{$a->sa->uuid}", ['role' => 'ADMIN']);
    assertMatchesContract(AU, 'patch', '/api/v1/admin/users/{id}', 409, $res);
    $sa->post("/api/v1/admin/users/{$sa2->uuid}:unlock")->assertOk();
    $sa->call('PATCH', "/api/v1/admin/users/{$sa2->uuid}", ['role' => 'ADMIN'])->assertOk();
    expect($sa2->fresh()->roleKey())->toBe('ADMIN');
    // Sai realm khi đổi vai trò → 422.
    expect($sa->call('PATCH', "/api/v1/admin/users/{$a->owner->uuid}", ['role' => 'ADMIN'])->status())->toBe(422);
});

it('If-Match sai → 412; đúng ETag → 200', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $etag = $sa->get("/api/v1/admin/users/{$a->owner->uuid}")->headers->get('ETag');
    $res = $sa->call('PATCH', "/api/v1/admin/users/{$a->owner->uuid}", ['name' => 'X'], ['If-Match' => 'W/"cu"']);
    assertMatchesContract(AU, 'patch', '/api/v1/admin/users/{id}', 412, $res);
    $sa->call('PATCH', "/api/v1/admin/users/{$a->owner->uuid}", ['name' => 'X'], ['If-Match' => $etag])->assertOk();
});

it('khóa user thu hồi phiên; mở khóa xóa bộ đếm đăng nhập sai; reset MFA xóa TOTP và phiên', function () {
    $a = new Actors($this);
    $owner = $this->spa();
    $owner->login($a->owner)->assertOk();
    $admin = $a->spa('AD_IN');
    $admin->post("/api/v1/admin/users/{$a->owner->uuid}:lock")->assertOk()->assertJsonPath('data.status', 'locked');
    $owner->get('/api/v1/auth/me')->assertStatus(401);
    $this->spa()->login($a->owner)->assertStatus(422);
    $admin->post("/api/v1/admin/users/{$a->owner->uuid}:unlock")->assertOk();
    expect(DB::table('login_attempts')->where('email', $a->owner->email)->where('success', false)->count())->toBe(0);

    MfaCredential::query()->create(['user_id' => $a->owner->id, 'type' => 'totp', 'secret_encrypted' => encrypt('x', false)]);
    $owner2 = $this->spa();
    $owner2->login($a->owner)->assertOk();
    $admin->post("/api/v1/admin/users/{$a->owner->uuid}:reset-mfa")->assertOk()->assertJsonPath('data.mfa_enabled', false);
    $owner2->get('/api/v1/auth/me')->assertStatus(401);
});

it('reset MFA và giả danh cần step-up trong 10 phút', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $this->travel(11)->minutes();
    expect($sa->post("/api/v1/admin/users/{$a->owner->uuid}:reset-mfa")->json('code'))->toBe('mfa_step_up_required')
        ->and($sa->post("/api/v1/admin/users/{$a->owner->uuid}:impersonate", ['reason' => 'Hỗ trợ'])->json('code'))
        ->toBe('mfa_step_up_required');
});

it('PUT scopes: chỉ cho ADMIN, uuid lạ → 422; Me của ADMIN có phạm vi mới', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $bad = $sa->call('PUT', "/api/v1/admin/users/{$a->adminOut->uuid}/scopes",
        ['scopes' => [['scope_type' => 'server', 'uuid' => '00000000-0000-4000-8000-000000000000']]]);
    assertMatchesContract(AU, 'put', '/api/v1/admin/users/{id}/scopes', 422, $bad);
    $sa->call('PUT', "/api/v1/admin/users/{$a->adminOut->uuid}/scopes",
        ['scopes' => [['scope_type' => 'server', 'uuid' => $a->server->uuid]]])->assertOk();
    $me = $a->spa('AD_OUT')->get('/api/v1/auth/me');
    expect($me->json('data.scopes'))->toBe([['scope_type' => 'server', 'uuid' => $a->server->uuid, 'name' => $a->server->name]])
        ->and($me->json('data.permissions'))->toContain('users.read')->not->toContain('*');
    // Giờ AD_OUT thấy chủ account trên server đó.
    $a->spa('AD_OUT')->get("/api/v1/admin/users/{$a->owner->uuid}")->assertOk();
});

it('giả danh: SA nhận vé → Portal đổi vé lấy phiên USER, Me có impersonating, chặn đổi mật khẩu, kết thúc ghi audit', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $res = $sa->post("/api/v1/admin/users/{$a->owner->uuid}:impersonate", ['reason' => 'Hỗ trợ cấu hình SSL']);
    assertMatchesContract(AU, 'post', '/api/v1/admin/users/{id}:impersonate', 201, $res);
    parse_str((string) parse_url($res->json('data.portal_url'), PHP_URL_QUERY), $q);
    expect($res->json('data.portal_url'))->toStartWith(config('itso.auth.app_urls.portal').'/impersonate?ticket=');

    $portal = $this->spa('portal');
    $portal->get('/api/v1/auth/csrf');
    $me = $portal->post('/api/v1/auth/impersonation:accept', ['ticket' => $q['ticket']]);
    assertMatchesContract(PO, 'post', '/api/v1/auth/impersonation:accept', 200, $me);
    expect($me->json('data.user.uuid'))->toBe($a->owner->uuid)
        ->and($me->json('data.impersonating.uuid'))->toBe($a->sa->uuid);
    expect($portal->post('/api/v1/auth/password:change', ['current_password' => 'x', 'new_password' => 'mat-khau-moi-123'])->status())->toBe(403);
    expect($portal->post('/api/v1/auth/mfa/totp:enroll')->status())->toBe(403);

    // Vé dùng một lần.
    $again = $this->spa('portal');
    $again->get('/api/v1/auth/csrf');
    assertMatchesContract(PO, 'post', '/api/v1/auth/impersonation:accept', 422, $again->post('/api/v1/auth/impersonation:accept', ['ticket' => $q['ticket']]));

    assertMatchesContract(PO, 'post', '/api/v1/auth/impersonation:end', 204, $portal->post('/api/v1/auth/impersonation:end'));
    $portal->get('/api/v1/auth/me')->assertStatus(401);
    expect(ImpersonationSession::query()->first()->ended_at)->not->toBeNull();
    $actions = AuditLog::query()->orderBy('id')->pluck('action')->all();
    expect($actions)->toContain('user.impersonate', 'impersonation.accept', 'impersonation.end');
    $acc = AuditLog::query()->where('action', 'impersonation.accept')->first();
    expect($acc->impersonator_user_id)->toBe($a->sa->id)->and($acc->actor_user_id)->toBe($a->owner->id);
});

it('giả danh hết hạn sau 30 phút; vé hết hạn sau 60 giây; không giả danh ADMIN hay USER bị khóa', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $ticket = function () use ($sa, $a) {
        parse_str((string) parse_url($sa->post("/api/v1/admin/users/{$a->owner->uuid}:impersonate", ['reason' => 'Hỗ trợ khách'])
            ->json('data.portal_url'), PHP_URL_QUERY), $q);

        return $q['ticket'];
    };
    $t1 = $ticket();
    $portal = $this->spa('portal');
    $portal->get('/api/v1/auth/csrf');
    $portal->post('/api/v1/auth/impersonation:accept', ['ticket' => $t1])->assertOk();
    $this->travel(31)->minutes();
    $portal->get('/api/v1/auth/me')->assertStatus(401);

    $sa = $a->spa('SA'); // step-up lại sau khi thời gian trôi
    $ticket = function () use ($sa, $a) {
        parse_str((string) parse_url($sa->post("/api/v1/admin/users/{$a->owner->uuid}:impersonate", ['reason' => 'Hỗ trợ khách'])
            ->json('data.portal_url'), PHP_URL_QUERY), $q);

        return $q['ticket'];
    };
    $t2 = $ticket();
    $this->travel(61)->seconds();
    $p2 = $this->spa('portal');
    $p2->get('/api/v1/auth/csrf');
    $p2->post('/api/v1/auth/impersonation:accept', ['ticket' => $t2])->assertStatus(422);

    $sa = $a->spa('SA');
    assertMatchesContract(AU, 'post', '/api/v1/admin/users/{id}:impersonate', 422,
        $sa->post("/api/v1/admin/users/{$a->adminIn->uuid}:impersonate", ['reason' => 'Hỗ trợ khách']));
    $a->owner->update(['status' => 'locked']);
    assertMatchesContract(AU, 'post', '/api/v1/admin/users/{id}:impersonate', 409,
        $sa->post("/api/v1/admin/users/{$a->owner->uuid}:impersonate", ['reason' => 'Hỗ trợ khách']));
});

it('audit ghi tạo/sửa/khóa user, che dữ liệu nhạy cảm, hash chain do DB tính', function () {
    $a = new Actors($this);
    $sa = $a->spa('SA');
    $sa->post('/api/v1/admin/users', ['realm' => 'portal', 'name' => 'A', 'email' => 'a@example.vn', 'role' => 'USER'])->assertCreated();
    $sa->call('PATCH', "/api/v1/admin/users/{$a->owner->uuid}", ['name' => 'Ten Moi'])->assertOk();
    $sa->post("/api/v1/admin/users/{$a->owner->uuid}:lock")->assertOk();
    $logs = AuditLog::query()->orderBy('id')->get();
    expect($logs->pluck('action')->all())->toBe(['user.create', 'user.update', 'user.lock'])
        ->and($logs->every(fn ($l) => $l->actor_user_id === $a->sa->id && $l->hash !== null))->toBeTrue()
        ->and($logs[1]->prev_hash)->toBe($logs[0]->hash)
        ->and($logs[1]->changes['before']['name'])->toBe('Chu Tai Khoan');
    expect(AuditLogger::redact(['password' => 'x', 'nested' => ['token' => 'y', 'ok' => 1]]))
        ->toBe(['password' => '[REDACTED]', 'nested' => ['token' => '[REDACTED]', 'ok' => 1]]);
});

it('danh sách user: phân trang cursor, sort sai → 422', function () {
    $a = new Actors($this);
    User::factory()->portalUser()->count(5)->create();
    $sa = $a->spa('SA');
    $p1 = $sa->get('/api/v1/admin/users', ['limit' => 3]);
    expect($p1->json('data'))->toHaveCount(3)->and($p1->json('meta.next_cursor'))->toBeString();
    $p2 = $sa->get('/api/v1/admin/users', ['limit' => 3, 'cursor' => $p1->json('meta.next_cursor')]);
    expect(collect($p2->json('data'))->pluck('uuid')->intersect(collect($p1->json('data'))->pluck('uuid')))->toBeEmpty();
    assertMatchesContract(AU, 'get', '/api/v1/admin/users', 422, $sa->get('/api/v1/admin/users', ['sort' => 'password_hash']));
});
