<?php

use App\Auth\Totp;
use App\Models\MfaCredential;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

const PA = 'itso-admin-v1.yaml';

/** Đăng ký + xác nhận TOTP cho phiên đã đăng nhập; trả [secret, recovery codes]. */
function enrollTotp($test, $spa): array
{
    $res = $spa->post('/api/v1/auth/mfa/totp:enroll');
    assertMatchesContract(PA, 'post', '/api/v1/auth/mfa/totp:enroll', 200, $res);
    $secret = $res->json('data.secret');
    $confirm = $spa->post('/api/v1/auth/mfa/totp:confirm', ['code' => Totp::at($secret, now()->getTimestamp()), 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/mfa/totp:confirm', 204, $confirm);
    $test->travel(31)->seconds(); // mã kế tiếp thuộc bước thời gian mới (chặn dùng lại)

    return [$secret, $res->json('data.recovery_codes')];
}

it('SUPER_ADMIN chưa bật MFA: login báo mfa_required, mọi thao tác bị chặn trừ me/enroll/logout', function () {
    $sa = User::factory()->superAdmin()->create();
    $spa = $this->spa('admin');
    $res = $spa->login($sa);
    expect($res->json('data'))->toBe(['mfa_required' => true, 'mfa_methods' => []]);

    $blocked = $spa->get('/api/v1/admin/system/version');
    expect($blocked->status())->toBe(403)->and($blocked->json('code'))->toBe('mfa_required');
    expect($spa->get('/api/v1/auth/sessions')->json('code'))->toBe('mfa_required');
    $spa->get('/api/v1/auth/me')->assertOk();

    enrollTotp($this, $spa);
    $spa->get('/api/v1/admin/system/version')->assertOk();
    expect(DB::table('sessions')->where('user_id', $sa->id)->value('mfa_verified_at'))->not->toBeNull();
});

it('enroll trả secret base32, otpauth URI và 10 mã khôi phục; secret lưu mã hóa', function () {
    $u = User::factory()->admin()->create(['email' => 'qt@example.vn']);
    $spa = $this->spa('admin');
    $spa->login($u)->assertOk();
    [$secret, $codes] = enrollTotp($this, $spa);
    expect($secret)->toMatch('/^[A-Z2-7]{32}$/')
        ->and($codes)->toHaveCount(10)->each->toMatch('/^[a-z0-9]{10}$/');

    $raw = DB::table('mfa_credentials')->where('user_id', $u->id)->where('type', 'totp')->first();
    $bytes = is_resource($raw->secret_encrypted) ? stream_get_contents($raw->secret_encrypted) : $raw->secret_encrypted;
    expect($bytes)->not->toContain($secret);
    $rec = MfaCredential::query()->where('user_id', $u->id)->where('type', 'recovery')->first();
    expect(decrypt($rec->secret_encrypted, false))->not->toContain($codes[0])->toContain('$argon2id$');

    // Đã bật thì enroll lại → 409.
    assertMatchesContract(PA, 'post', '/api/v1/auth/mfa/totp:enroll', 409, $spa->post('/api/v1/auth/mfa/totp:enroll'));
});

it('confirm sai mã → 422; confirm khi chưa enroll → 409', function () {
    $spa = $this->spa('admin');
    $spa->login(User::factory()->admin()->create())->assertOk();
    $res = $spa->post('/api/v1/auth/mfa/totp:confirm', ['code' => '000000', 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/mfa/totp:confirm', 409, $res);
    $secret = $spa->post('/api/v1/auth/mfa/totp:enroll')->json('data.secret');
    $wrong = Totp::at($secret, now()->getTimestamp() + 300);
    $res = $spa->post('/api/v1/auth/mfa/totp:confirm', ['code' => $wrong, 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/mfa/totp:confirm', 422, $res);
    expect($res->json('errors.code'))->not->toBeEmpty();
});

it('login khi đã bật TOTP: mfa_required, chưa verify bị chặn; verify TOTP → Me, phiên mới', function () {
    $u = User::factory()->admin()->create();
    $spa = $this->spa('admin');
    $spa->login($u)->assertOk();
    [$secret] = enrollTotp($this, $spa);
    $spa->post('/api/v1/auth/logout')->assertNoContent();

    $res = $spa->login($u);
    expect($res->json('data'))->toBe(['mfa_required' => true, 'mfa_methods' => ['totp', 'recovery']]);
    expect($spa->get('/api/v1/admin/system/version')->json('code'))->toBe('mfa_required');
    expect($spa->get('/api/v1/auth/me')->json('data.mfa_verified_at'))->toBeNull();

    $before = $spa->jar['itso_admin_session'];
    $ok = $spa->post('/api/v1/auth/mfa/verify', ['code' => Totp::at($secret, now()->getTimestamp()), 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/mfa/verify', 200, $ok);
    expect($ok->json('data.mfa_verified_at'))->not->toBeNull()
        ->and($spa->jar['itso_admin_session'])->not->toBe($before);
    $spa->get('/api/v1/admin/system/version')->assertOk();
});

it('verify: mã sai 422, dùng lại cùng mã bị từ chối, quá 5 lần/phút → 429', function () {
    $u = User::factory()->admin()->create();
    $spa = $this->spa('admin');
    $spa->login($u)->assertOk();
    [$secret] = enrollTotp($this, $spa);
    $code = Totp::at($secret, now()->getTimestamp());
    $spa->post('/api/v1/auth/mfa/verify', ['code' => $code, 'method' => 'totp'])->assertOk();

    $spa->login($u)->assertOk();
    $replay = $spa->post('/api/v1/auth/mfa/verify', ['code' => $code, 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/mfa/verify', 422, $replay);
    for ($i = 0; $i < 4; $i++) {
        $spa->post('/api/v1/auth/mfa/verify', ['code' => '000000', 'method' => 'totp'])->assertStatus(422);
    }
    $limited = $spa->post('/api/v1/auth/mfa/verify', ['code' => '000000', 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/mfa/verify', 429, $limited);
});

it('verify không có phiên đăng nhập → 422', function () {
    $spa = $this->spa('admin');
    $spa->get('/api/v1/auth/csrf');
    $res = $spa->post('/api/v1/auth/mfa/verify', ['code' => '123456', 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/mfa/verify', 422, $res);
});

it('mã khôi phục dùng được một lần', function () {
    $u = User::factory()->portalUser()->create();
    $spa = $this->spa('portal');
    $spa->login($u)->assertOk();
    [, $codes] = enrollTotp($this, $spa);

    $spa->login($u)->assertOk();
    $spa->post('/api/v1/auth/mfa/verify', ['code' => $codes[3], 'method' => 'recovery'])->assertOk();
    $spa->login($u)->assertOk();
    $spa->post('/api/v1/auth/mfa/verify', ['code' => $codes[3], 'method' => 'recovery'])->assertStatus(422);
    $spa->post('/api/v1/auth/mfa/verify', ['code' => $codes[4], 'method' => 'recovery'])->assertOk();
});

it('step-up: đặt mốc xác thực lại; route nhạy cảm cần step-up trong 10 phút', function () {
    Route::middleware(['itso.web', 'itso.auth:admin', 'itso.mfa', 'itso.step-up'])
        ->post('/api/v1/admin/__sensitive', fn () => response()->noContent());
    $u = User::factory()->admin()->create();
    $spa = $this->spa('admin');
    $spa->login($u)->assertOk();

    expect($spa->post('/api/v1/admin/__sensitive')->json('code'))->toBe('mfa_required'); // chưa bật MFA
    $res = $spa->post('/api/v1/auth/step-up', ['code' => '123456', 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/step-up', 409, $res);

    [$secret] = enrollTotp($this, $spa);
    $denied = $spa->post('/api/v1/admin/__sensitive');
    expect($denied->status())->toBe(403)->and($denied->json('code'))->toBe('mfa_step_up_required');

    $wrong = $spa->post('/api/v1/auth/step-up', ['code' => '000000', 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/step-up', 422, $wrong);
    $ok = $spa->post('/api/v1/auth/step-up', ['code' => Totp::at($secret, now()->getTimestamp()), 'method' => 'totp']);
    assertMatchesContract(PA, 'post', '/api/v1/auth/step-up', 200, $ok);
    $spa->post('/api/v1/admin/__sensitive')->assertNoContent();

    $this->travel(601)->seconds();
    expect($spa->post('/api/v1/admin/__sensitive')->json('code'))->toBe('mfa_step_up_required');
});

it('Me của phiên đã xác minh có mfa_verified_at; user.mfa_enabled đúng', function () {
    $u = User::factory()->admin()->create();
    $spa = $this->spa('admin');
    $spa->login($u)->assertOk();
    enrollTotp($this, $spa);
    $me = $spa->get('/api/v1/auth/me');
    assertMatchesContract(PA, 'get', '/api/v1/auth/me', 200, $me);
    expect($me->json('data.user.mfa_enabled'))->toBeTrue()
        ->and(Carbon::parse($me->json('data.mfa_verified_at'))->isPast())->toBeTrue();
});
