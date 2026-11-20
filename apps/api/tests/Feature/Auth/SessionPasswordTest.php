<?php

use App\Mail\PasswordResetMail;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;

const PP = 'itso-portal-v1.yaml';

it('GET /auth/sessions liệt kê phiên của tôi trong realm, đánh dấu phiên hiện tại, không lộ session id', function () {
    $u = User::factory()->portalUser()->create();
    $a = $this->spa('portal', '198.51.100.1');
    $a->login($u)->assertOk();
    $b = $this->spa('portal', '198.51.100.2');
    $b->login($u)->assertOk();
    $other = $this->spa('portal');
    $other->login(User::factory()->portalUser()->create())->assertOk();

    $res = $a->get('/api/v1/auth/sessions');
    assertMatchesContract(PP, 'get', '/api/v1/auth/sessions', 200, $res);
    $data = $res->json('data');
    expect($data)->toHaveCount(2)
        ->and(collect($data)->where('current', true)->pluck('ip')->all())->toBe(['198.51.100.1'])
        ->and(collect($data)->pluck('ip')->sort()->values()->all())->toBe(['198.51.100.1', '198.51.100.2']);
    $ids = DB::table('sessions')->pluck('id')->all();
    expect(collect($data)->pluck('uuid')->intersect($ids))->toBeEmpty();
});

it('DELETE /auth/sessions/{id} thu hồi phiên khác; phiên hiện tại → 409; lạ → 404', function () {
    $u = User::factory()->portalUser()->create();
    $a = $this->spa();
    $a->login($u)->assertOk();
    $b = $this->spa();
    $b->login($u)->assertOk();
    $list = collect($a->get('/api/v1/auth/sessions')->json('data'));
    $bId = $list->firstWhere('current', false)['uuid'];
    $aId = $list->firstWhere('current', true)['uuid'];

    assertMatchesContract(PP, 'delete', '/api/v1/auth/sessions/{id}', 409, $a->delete("/api/v1/auth/sessions/$aId"));
    assertMatchesContract(PP, 'delete', '/api/v1/auth/sessions/{id}', 204, $a->delete("/api/v1/auth/sessions/$bId"));
    $b->get('/api/v1/auth/me')->assertStatus(401);
    $a->get('/api/v1/auth/me')->assertOk();
    $missing = $a->delete('/api/v1/auth/sessions/00000000-0000-8000-8000-000000000000');
    assertMatchesContract(PP, 'delete', '/api/v1/auth/sessions/{id}', 404, $missing);
});

it('password:change: sai mật khẩu hiện tại 422; đúng → 204, phiên khác bị thu hồi', function () {
    $u = User::factory()->portalUser()->create(['must_change_password' => true]);
    $a = $this->spa();
    $a->login($u)->assertOk();
    $b = $this->spa();
    $b->login($u)->assertOk();

    $bad = $a->post('/api/v1/auth/password:change', ['current_password' => 'sai', 'new_password' => 'mat-khau-moi-123']);
    assertMatchesContract(PP, 'post', '/api/v1/auth/password:change', 422, $bad);
    $short = $a->post('/api/v1/auth/password:change', ['current_password' => 'password-dev-only', 'new_password' => 'ngan']);
    expect($short->json('errors'))->toHaveKey('new_password');

    $ok = $a->post('/api/v1/auth/password:change', ['current_password' => 'password-dev-only', 'new_password' => 'mat-khau-moi-123']);
    assertMatchesContract(PP, 'post', '/api/v1/auth/password:change', 204, $ok);
    expect(Hash::check('mat-khau-moi-123', $u->fresh()->password_hash))->toBeTrue()
        ->and(str_starts_with($u->fresh()->password_hash, '$argon2id$'))->toBeTrue()
        ->and($u->fresh()->must_change_password)->toBeFalse();
    $a->get('/api/v1/auth/me')->assertOk();
    $b->get('/api/v1/auth/me')->assertStatus(401);
});

it('password:forgot luôn 204; gửi mail có link một lần, hết hạn 60 phút', function () {
    Mail::fake();
    $u = User::factory()->portalUser()->create(['email' => 'khach@example.vn']);
    User::factory()->admin()->create(['email' => 'qt@example.vn']);
    $spa = $this->spa();
    $spa->get('/api/v1/auth/csrf');

    assertMatchesContract(PP, 'post', '/api/v1/auth/password:forgot', 204,
        $spa->post('/api/v1/auth/password:forgot', ['email' => 'khong-co@example.vn']));
    assertMatchesContract(PP, 'post', '/api/v1/auth/password:forgot', 204,
        $spa->post('/api/v1/auth/password:forgot', ['email' => 'qt@example.vn'])); // sai realm
    Mail::assertNothingSent();

    $spa->post('/api/v1/auth/password:forgot', ['email' => 'khach@example.vn'])->assertNoContent();
    $url = null;
    Mail::assertSent(PasswordResetMail::class, function (PasswordResetMail $m) use (&$url) {
        $url = $m->url;

        return $m->hasTo('khach@example.vn') && $m->minutes === 60;
    });
    parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
    expect($url)->toStartWith(config('itso.auth.app_urls.portal').'/reset-password?');

    $b = $this->spa();
    $b->login($u)->assertOk();

    $bad = $spa->post('/api/v1/auth/password:reset', ['token' => str_repeat('x', 64), 'email' => 'khach@example.vn', 'password' => 'mat-khau-moi-123']);
    assertMatchesContract(PP, 'post', '/api/v1/auth/password:reset', 422, $bad);
    $ok = $spa->post('/api/v1/auth/password:reset', ['token' => $q['token'], 'email' => 'khach@example.vn', 'password' => 'mat-khau-moi-123']);
    assertMatchesContract(PP, 'post', '/api/v1/auth/password:reset', 204, $ok);
    $b->get('/api/v1/auth/me')->assertStatus(401);
    $this->spa()->login($u, 'mat-khau-moi-123')->assertOk();

    // Dùng lại token → 422.
    $spa->post('/api/v1/auth/password:reset', ['token' => $q['token'], 'email' => 'khach@example.vn', 'password' => 'mat-khau-khac-456'])
        ->assertStatus(422);
});

it('token đặt lại mật khẩu hết hạn sau 60 phút', function () {
    Mail::fake();
    $u = User::factory()->portalUser()->create();
    $spa = $this->spa();
    $spa->get('/api/v1/auth/csrf');
    $spa->post('/api/v1/auth/password:forgot', ['email' => $u->email])->assertNoContent();
    $url = '';
    Mail::assertSent(PasswordResetMail::class, function (PasswordResetMail $m) use (&$url) {
        $url = $m->url;

        return true;
    });
    parse_str((string) parse_url($url, PHP_URL_QUERY), $q);
    $this->travel(61)->minutes();
    $spa->post('/api/v1/auth/password:reset', ['token' => $q['token'], 'email' => $u->email, 'password' => 'mat-khau-moi-123'])
        ->assertStatus(422);
});

it('nội dung mail đặt lại mật khẩu có link nguyên vẹn (không escape &)', function () {
    $html = (new PasswordResetMail('An', 'https://x.local/reset-password?token=abc&email=a%40b.vn', 60))->render();
    expect($html)->toContain('token=abc&email=a%40b.vn')->toContain('60');
});
