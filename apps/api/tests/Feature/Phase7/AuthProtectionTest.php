<?php

use App\Auth\Captcha;
use App\Models\Setting;
use App\Models\User;
use Tests\Support\Actors;
use Tests\Support\Spa;

// Prompt 7.4: CAPTCHA proof-of-work tự host (D-81), auth.log cho fail2ban, tùy chọn bắt buộc MFA cho USER.

require_once __DIR__.'/helpers.php';

/** Tìm nonce như Web Worker của trình duyệt. */
function p7solve(array $c): string
{
    for ($n = 0; ; $n++) {
        if (Captcha::solves($c['challenge'], (string) $n, $c['difficulty'])) {
            return (string) $n;
        }
    }
}

function p7login(Spa $spa, User $u, string $pw, ?array $captcha = null)
{
    $spa->get('/api/v1/auth/csrf');
    $body = ['email' => $u->email, 'password' => $pw];
    if ($captcha !== null) {
        $body['captcha'] = $captcha;
    }

    return $spa->post('/api/v1/auth/login', $body);
}

beforeEach(function () {
    config(['itso.security.captcha_difficulty' => 8]);
});

it('CAPTCHA: sau 3 lần sai cần lời giải; sai/thiếu/dùng lại/hết hạn → 422 captcha_required; đúng → đăng nhập', function () {
    $u = User::factory()->portalUser()->create();
    $spa = $this->spa('portal', '203.0.113.20');
    for ($i = 0; $i < 3; $i++) {
        expect(p7login($spa, $u, 'sai')->json('code'))->toBe('validation_failed');
    }
    $need = p7login($spa, $u, 'password-dev-only');
    assertMatchesContract(P7P, 'post', '/api/v1/auth/login', 422, $need);
    expect($need->json('code'))->toBe('captcha_required');

    $c = $spa->get('/api/v1/auth/captcha');
    assertMatchesContract(P7P, 'get', '/api/v1/auth/captcha', 200, $c);
    $ch = $c->json('data');
    expect($ch['difficulty'])->toBe(8)->and($c->headers->get('Cache-Control'))->toContain('no-store');
    $nonce = p7solve($ch);
    // Lời giải sai (nonce khác không đạt độ khó) / challenge bị sửa.
    $wrong = (string) collect(range(0, 500))->first(fn (int $n) => ! Captcha::solves($ch['challenge'], (string) $n, 8));
    expect(p7login($spa, $u, 'password-dev-only', ['challenge' => $ch['challenge'], 'nonce' => $wrong])->json('code'))->toBe('captcha_required')
        ->and(p7login($spa, $u, 'password-dev-only', ['challenge' => 'x'.$ch['challenge'], 'nonce' => $nonce])->json('code'))->toBe('captcha_required');
    // Challenge của realm admin không dùng cho portal.
    $adminCh = $this->spa('admin')->get('/api/v1/auth/captcha')->json('data');
    expect(p7login($spa, $u, 'password-dev-only', ['challenge' => $adminCh['challenge'], 'nonce' => p7solve($adminCh)])->json('code'))->toBe('captcha_required');

    $ok = p7login($spa, $u, 'password-dev-only', ['challenge' => $ch['challenge'], 'nonce' => $nonce]);
    $ok->assertOk();
    $this->travel(1)->seconds(); // đồng hồ test đứng yên: tách mốc lần đúng với các lần sai sau
    // Dùng lại cùng lời giải → từ chối (Cache::add một lần), kể cả khi đăng nhập đúng.
    $spa2 = $this->spa('portal', '203.0.113.20');
    for ($i = 0; $i < 3; $i++) {
        p7login($spa2, $u, 'sai');
    }
    $reuse = p7login($spa2, $u, 'password-dev-only', ['challenge' => $ch['challenge'], 'nonce' => $nonce]);
    expect($reuse->json('code'))->toBe('captcha_required')->and($reuse->json('detail'))->toContain('đã được dùng');
    // Hết hạn sau 5 phút.
    $c2 = $spa2->get('/api/v1/auth/captcha')->json('data');
    $this->travel(301)->seconds();
    expect(p7login($spa2, $u, 'password-dev-only', ['challenge' => $c2['challenge'], 'nonce' => p7solve($c2)])->json('detail'))->toContain('hết hạn');
});

it('CAPTCHA: ngưỡng 0 = luôn bật; realm admin không cần (đã có fail2ban + khóa lũy tiến); quên mật khẩu cũng áp dụng', function () {
    Setting::query()->create(['group_key' => 'security', 'key' => 'portal_captcha_after_failures', 'value' => ['v' => 0]]);
    $u = User::factory()->portalUser()->create();
    $spa = $this->spa();
    expect(p7login($spa, $u, 'password-dev-only')->json('code'))->toBe('captcha_required');
    expect($spa->post('/api/v1/auth/password:forgot', ['email' => $u->email])->json('code'))->toBe('captcha_required');
    $c = $spa->get('/api/v1/auth/captcha')->json('data');
    $spa->post('/api/v1/auth/password:forgot', ['email' => $u->email, 'captcha' => ['challenge' => $c['challenge'], 'nonce' => p7solve($c)]])->assertNoContent();
    $sa = User::factory()->superAdmin()->create();
    $this->spa('admin')->login($sa)->assertOk();
});

it('đăng nhập sai ghi auth.log cho fail2ban: chỉ thời điểm + IP, đúng định dạng failregex của agent', function () {
    $dir = sys_get_temp_dir().'/itso-auth-'.bin2hex(random_bytes(4));
    mkdir($dir);
    config(['itso.security.auth_log' => "$dir/auth.log"]);
    $u = User::factory()->portalUser()->create();
    p7login($this->spa('portal', '198.51.100.23'), $u, 'mat-khau-sai-123');
    $this->spa('portal', '198.51.100.23')->login($u)->assertOk();
    $lines = file("$dir/auth.log", FILE_IGNORE_NEW_LINES);
    expect($lines)->toHaveCount(1)
        ->and($lines[0])->toMatch('/^\S+ itso-auth failed ip=198\.51\.100\.23$/')
        ->and($lines[0])->not->toContain($u->email)->and($lines[0])->not->toContain('mat-khau-sai');
});

it('portal_mfa_required: USER chưa bật MFA bị chặn mọi thao tác trừ đăng ký MFA; tắt thì như cũ', function () {
    $a = new Actors($this);
    Setting::query()->create(['group_key' => 'security', 'key' => 'portal_mfa_required', 'value' => ['v' => true]]);
    $spa = $this->spa();
    $login = $spa->login($a->owner);
    expect($login->json('data.mfa_required'))->toBeTrue()->and($login->json('data.mfa_methods'))->toBe([]);
    $r = $spa->get('/api/v1/portal/hosting-accounts');
    expect($r->status())->toBe(403)->and($r->json('code'))->toBe('mfa_required');
    expect($spa->post('/api/v1/auth/mfa/totp:enroll')->status())->toBe(200);
    Setting::query()->where('key', 'portal_mfa_required')->update(['value' => ['v' => false]]);
    $spa2 = $this->spa();
    $spa2->login($a->otherUser)->assertOk();
    expect($spa2->get('/api/v1/portal/hosting-accounts')->status())->toBe(200);
});
