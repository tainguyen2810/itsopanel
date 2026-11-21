<?php

use App\Models\User;
use Illuminate\Support\Facades\DB;

const P = 'itso-portal-v1.yaml';
const A = 'itso-admin-v1.yaml';

it('GET /auth/csrf trả 204 và cookie XSRF theo realm', function () {
    $spa = $this->spa('admin');
    $res = $spa->get('/api/v1/auth/csrf');
    assertMatchesContract(A, 'get', '/api/v1/auth/csrf', 204, $res);
    expect($spa->jar)->toHaveKeys(['XSRF-TOKEN-ADMIN', 'itso_admin_session'])
        ->and($spa->jar)->not->toHaveKey('itso_portal_session');
});

it('login portal đúng → 200 khớp LoginResult, phiên lưu realm portal', function () {
    $u = User::factory()->portalUser()->create(['email' => 'khach@example.vn']);
    $spa = $this->spa('portal');
    $res = $spa->login('KHACH@example.vn');
    assertMatchesContract(P, 'post', '/api/v1/auth/login', 200, $res);
    expect($res->json('data'))->toBe(['mfa_required' => false, 'mfa_methods' => []]);

    $row = DB::table('sessions')->where('user_id', $u->id)->first();
    expect($row->realm)->toBe('portal')->and($row->mfa_verified_at)->toBeNull();
    expect($u->fresh()->last_login_at)->not->toBeNull();
    expect(DB::table('login_attempts')->where('email', 'khach@example.vn')->value('success'))->toBeTrue();
});

it('GET /auth/me khớp Me (user, quyền, phạm vi, mfa)', function () {
    $u = User::factory()->portalUser()->create();
    $spa = $this->spa('portal');
    $spa->login($u)->assertOk();
    $res = $spa->get('/api/v1/auth/me');
    assertMatchesContract(P, 'get', '/api/v1/auth/me', 200, $res);
    expect($res->json('data.user.uuid'))->toBe($u->uuid)
        ->and($res->json('data.user.role'))->toBe('USER')
        ->and($res->json('data.user.mfa_enabled'))->toBeFalse()
        ->and($res->json('data.impersonating'))->toBeNull()
        ->and($res->json())->not->toHaveKey('data.user.password_hash');
});

it('sai mật khẩu, email lạ, sai realm, tài khoản bị khóa: cùng lỗi 422', function () {
    $admin = User::factory()->admin()->create(['email' => 'qt@example.vn']);
    User::factory()->portalUser()->create(['email' => 'khoa@example.vn', 'status' => 'locked']);
    $spa = $this->spa('portal');

    $cases = [
        ['qt@example.vn', 'password-dev-only'],   // user admin đăng nhập vào portal
        ['khong-co@example.vn', 'password-dev-only'],
        ['khoa@example.vn', 'password-dev-only'],
    ];
    $bodies = [];
    foreach ($cases as [$email, $pw]) {
        $res = $spa->login($email, $pw);
        assertMatchesContract(P, 'post', '/api/v1/auth/login', 422, $res);
        $bodies[] = [$res->json('code'), $res->json('errors')];
    }
    $wrong = $this->spa('admin')->login($admin, 'sai-mat-khau');
    assertMatchesContract(A, 'post', '/api/v1/auth/login', 422, $wrong);
    $bodies[] = [$wrong->json('code'), $wrong->json('errors')];

    expect(array_unique(array_map('serialize', $bodies)))->toHaveCount(1)
        ->and($bodies[0])->toBe(['validation_failed', ['email' => ['Email hoặc mật khẩu không đúng.']]]);
});

it('thiếu trường → 422 validation_failed theo từng trường', function () {
    $res = $this->spa()->login('', '');
    assertMatchesContract(P, 'post', '/api/v1/auth/login', 422, $res);
    expect($res->json('errors'))->toHaveKeys(['email', 'password']);
});

it('khóa lũy tiến: sai 5 lần → lần 6 bị 429 kể cả đúng mật khẩu; hết hạn khóa đăng nhập được', function () {
    // Phase 7: CAPTCHA Portal mặc định bật sau 3 lần sai; test này chỉ kiểm khóa lũy tiến (CAPTCHA: Phase7/AuthProtectionTest).
    config(['itso_settings.security.portal_captcha_after_failures.default' => 10]);
    $u = User::factory()->portalUser()->create();
    $spa = $this->spa();
    for ($i = 0; $i < 5; $i++) {
        $spa->login($u, 'sai')->assertStatus(422);
    }
    $locked = $spa->login($u);
    assertMatchesContract(P, 'post', '/api/v1/auth/login', 429, $locked);
    expect($locked->json('code'))->toBe('rate_limited')
        ->and((int) $locked->headers->get('Retry-After'))->toBeGreaterThan(0)->toBeLessThanOrEqual(60);

    $this->travel(61)->seconds();
    $spa->login($u, 'sai')->assertStatus(422);          // lần sai thứ 6 → khóa 2 phút
    $this->travel(61)->seconds();
    $spa->login($u)->assertStatus(429);
    $this->travel(60)->seconds();
    $spa->login($u)->assertOk();
    // Đăng nhập đúng xóa bộ đếm.
    $spa->login($u, 'sai')->assertStatus(422);
    $spa->login($u)->assertOk();
});

it('khóa theo IP khi một IP thử nhiều email', function () {
    config(['itso.auth.lockout.ip_threshold' => 3]);
    $spa = $this->spa('portal', '203.0.113.9');
    foreach (['a', 'b', 'c'] as $x) {
        $spa->login("$x@example.vn", 'sai')->assertStatus(422);
    }
    $u = User::factory()->portalUser()->create();
    $spa->login($u)->assertStatus(429);
    $this->spa('portal', '203.0.113.10')->login($u)->assertOk();
});

it('logout → 204, phiên bị hủy, me trả 401', function () {
    $spa = $this->spa();
    $spa->login(User::factory()->portalUser()->create())->assertOk();
    assertMatchesContract(P, 'post', '/api/v1/auth/logout', 204, $spa->post('/api/v1/auth/logout'));
    $res = $spa->get('/api/v1/auth/me');
    assertMatchesContract(P, 'get', '/api/v1/auth/me', 401, $res);
    expect(DB::table('sessions')->whereNotNull('user_id')->count())->toBe(0);
});

it('CSRF: POST thiếu hoặc sai X-XSRF-TOKEN → 419 csrf_mismatch', function () {
    $u = User::factory()->portalUser()->create();
    $spa = $this->spa();
    $spa->get('/api/v1/auth/csrf');
    $spa->sendXsrf = false;
    $res = $spa->post('/api/v1/auth/login', ['email' => $u->email, 'password' => 'password-dev-only']);
    expect($res->status())->toBe(419)
        ->and($res->json('code'))->toBe('csrf_mismatch')
        ->and($res->headers->get('Content-Type'))->toBe('application/problem+json');
    $res = $spa->call('POST', '/api/v1/auth/login', ['email' => $u->email, 'password' => 'password-dev-only'],
        ['X-XSRF-TOKEN' => 'gia-mao']);
    expect($res->status())->toBe(419);

    // Phiên đã đăng nhập vẫn cần CSRF cho thao tác ghi.
    $spa->sendXsrf = true;
    $spa->login($u)->assertOk();
    $spa->sendXsrf = false;
    expect($spa->post('/api/v1/auth/logout')->status())->toBe(419);
});

it('realm tách biệt: phiên admin không gọi được API portal và ngược lại', function () {
    $admin = $this->spa('admin');
    $admin->login(User::factory()->admin()->create())->assertOk();
    $portal = $this->spa('portal');
    $portal->login(User::factory()->portalUser()->create())->assertOk();

    $admin->get('/api/v1/admin/system/version')->assertOk();
    // Endpoint /portal/* có từ 3.5; ở đây dùng /auth/me với realm portal.
    $admin->call('GET', '/api/v1/auth/me', [], ['X-ITSO-Realm' => 'portal'])->assertStatus(401);
    $portal->get('/api/v1/admin/system/version')->assertStatus(401);

    // Cookie phiên admin gửi kèm request portal (đổi tên cookie) vẫn không dùng được.
    $forged = $this->spa('portal');
    $forged->jar = ['itso_portal_session' => $admin->jar['itso_admin_session']];
    $forged->get('/api/v1/auth/me')->assertStatus(401);

    // Header X-ITSO-Realm=admin với cookie portal: không thấy phiên admin.
    $res = $portal->call('GET', '/api/v1/auth/me', [], ['X-ITSO-Realm' => 'admin']);
    expect($res->status())->toBe(401);
});

it('realm /auth theo host khi cấu hình hai origin', function () {
    config(['itso.auth.hosts.admin' => 'panel.itso.local', 'itso.auth.hosts.portal' => 'my.itso.local']);
    $u = User::factory()->admin()->create();
    $spa = $this->spa('portal'); // header nói portal nhưng host là admin
    $spa->call('GET', 'http://panel.itso.local/api/v1/auth/csrf');
    $res = $spa->call('POST', 'http://panel.itso.local/api/v1/auth/login', ['email' => $u->email, 'password' => 'password-dev-only'],
        ['X-XSRF-TOKEN' => $spa->jar['XSRF-TOKEN-ADMIN'] ?? '']);
    $res->assertOk();
    expect($spa->jar)->toHaveKey('itso_admin_session');
});

it('remember=false → cookie phiên hết khi đóng trình duyệt; remember=true → có hạn', function () {
    $u = User::factory()->portalUser()->create();
    $res = $this->spa()->login($u, remember: false);
    $c = collect($res->headers->getCookies())->first(fn ($c) => $c->getName() === 'itso_portal_session');
    expect($c->getExpiresTime())->toBe(0);
    $res = $this->spa()->login($u, remember: true);
    $c = collect($res->headers->getCookies())->first(fn ($c) => $c->getName() === 'itso_portal_session');
    expect($c->getExpiresTime())->toBeGreaterThan(time());
});
