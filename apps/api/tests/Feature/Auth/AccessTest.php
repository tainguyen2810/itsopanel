<?php

use App\Auth\ApiTokenAuth;
use App\Models\ApiToken;
use App\Models\User;
use Illuminate\Support\Facades\DB;

function makeToken(User $u, array $attrs = []): string
{
    ['plain' => $plain, 'hash' => $hash] = ApiTokenAuth::newToken();
    ApiToken::query()->create(array_merge(['user_id' => $u->id, 'name' => 'ci', 'token_hash' => $hash,
        'scopes' => ['system:read'], 'expires_at' => now()->addDay()], $attrs));

    return $plain;
}

it('IP allowlist: danh sách admin trống → không giới hạn; có CIDR → chỉ IP thuộc CIDR vào realm admin', function () {
    $u = User::factory()->admin()->create();
    $this->spa('admin', '203.0.113.5')->login($u)->assertOk();

    DB::table('ip_allowlist')->insert(['cidr' => '10.0.0.0/8', 'scope' => 'admin']);
    $out = $this->spa('admin', '203.0.113.5');
    $res = $out->get('/api/v1/auth/csrf');
    expect($res->status())->toBe(403)->and($res->json('code'))->toBe('ip_not_allowed');
    $this->spa('admin', '10.1.2.3')->login($u)->assertOk();

    // Realm portal không bị ảnh hưởng.
    $this->spa('portal', '203.0.113.5')->login(User::factory()->portalUser()->create())->assertOk();
});

it('API token: Bearer hợp lệ gọi được admin API, không cần CSRF/MFA', function () {
    $sa = User::factory()->superAdmin()->create();
    $token = makeToken($sa);
    $res = $this->withToken($token)->getJson('/api/v1/admin/system/version');
    assertMatchesContract('itso-admin-v1.yaml', 'get', '/api/v1/admin/system/version', 200, $res);
    expect(ApiToken::query()->first()->last_used_at)->not->toBeNull();
    expect(DB::table('api_tokens')->value('token_hash'))->toBe(hash('sha256', $token));
});

it('API token bị từ chối khi sai, hết hạn, ngoài CIDR, thiếu scope, user portal/khóa, hoặc gọi portal', function () {
    $admin = User::factory()->admin()->create();
    $this->withToken('itso_khong-ton-tai')->getJson('/api/v1/admin/system/version')->assertStatus(401);
    $this->withToken(makeToken($admin, ['expires_at' => now()->subMinute()]))
        ->getJson('/api/v1/admin/system/version')->assertStatus(401);

    $cidr = makeToken($admin);
    DB::statement("UPDATE api_tokens SET allowed_cidrs = '{10.0.0.0/8}' WHERE token_hash = ?", [hash('sha256', $cidr)]);
    $this->withToken($cidr)->getJson('/api/v1/admin/system/version')->assertStatus(401);
    $this->withToken($cidr)->withServerVariables(['REMOTE_ADDR' => '10.9.9.9'])
        ->getJson('/api/v1/admin/system/version')->assertOk();

    $noScope = $this->withToken(makeToken($admin, ['scopes' => ['servers:read']]))->getJson('/api/v1/admin/system/version');
    expect($noScope->status())->toBe(403)->and($noScope->json('code'))->toBe('forbidden');
    $this->withToken(makeToken($admin, ['scopes' => ['system:write']]))->getJson('/api/v1/admin/system/version')->assertOk();

    $locked = User::factory()->admin()->create(['status' => 'locked']);
    $this->withToken(makeToken($locked))->getJson('/api/v1/admin/system/version')->assertStatus(401);
    $portalUser = User::factory()->portalUser()->create();
    $this->withToken(makeToken($portalUser))->getJson('/api/v1/admin/system/version')->assertStatus(401);
    $this->withToken(makeToken($admin))->getJson('/api/v1/auth/me', ['X-ITSO-Realm' => 'portal'])->assertStatus(401);
});

it('IP allowlist scope api áp cho request bằng token', function () {
    $token = makeToken(User::factory()->admin()->create());
    DB::table('ip_allowlist')->insert(['cidr' => '192.0.2.0/24', 'scope' => 'api']);
    $res = $this->withToken($token)->getJson('/api/v1/admin/system/version');
    expect($res->json('code'))->toBe('ip_not_allowed');
    $this->withToken($token)->withServerVariables(['REMOTE_ADDR' => '192.0.2.7'])
        ->getJson('/api/v1/admin/system/version')->assertOk();
});

it('user bị khóa giữa chừng: phiên hiện có bị đăng xuất', function () {
    $u = User::factory()->portalUser()->create();
    $spa = $this->spa();
    $spa->login($u)->assertOk();
    $u->update(['status' => 'disabled']);
    $spa->get('/api/v1/auth/me')->assertStatus(401);
});
