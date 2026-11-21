<?php

use App\Auth\Totp;
use App\Domain\Setup\SetupWizard;
use App\Models\AuditLog;
use App\Models\User;
use Illuminate\Support\Str;
use Tests\Support\Spa;
use Tests\TestCase;

// Prompt 4.5: wizard cài đặt lần đầu — mã một lần, bước 0/1/2/3/6/9, khóa sau khi xong.

const SW = 'itso-admin-v1.yaml';

/** Ghi file băm mã thiết lập như `itso setup-code`; trả mã dạng XXXX-XXXX-XXXX. */
function setupCode(int $ttlMin = 60): string
{
    $raw = strtoupper(Str::random(12));
    $raw = strtr($raw, ['I' => 'J', 'O' => 'P', '0' => '2', '1' => '3']);
    $file = sys_get_temp_dir().'/itso-setup-'.Str::random(8).'.json';
    file_put_contents($file, json_encode(['sha256' => hash('sha256', $raw),
        'created_at' => now()->utc()->toIso8601String(), 'expires_at' => now()->addMinutes($ttlMin)->utc()->toIso8601String()]));
    config(['itso.setup_code_file' => $file]);

    return substr($raw, 0, 4).'-'.substr($raw, 4, 4).'-'.substr($raw, 8, 4);
}

/** Trình duyệt mới (phiên riêng) đã lấy cookie CSRF, như trang /install. */
function wizardSpa(TestCase $t): Spa
{
    $spa = $t->spa('admin');
    $spa->get('/api/v1/auth/csrf')->assertNoContent();

    return $spa;
}

it('đi hết wizard: mã → ngôn ngữ → SA + TOTP → truy cập → quota → khóa; mọi phản hồi khớp hợp đồng', function () {
    $spa = wizardSpa($this);
    $st = $spa->get('/api/v1/admin/setup/status');
    assertMatchesContract(SW, 'get', '/api/v1/admin/setup/status', 200, $st);
    expect($st->json('data'))->toMatchArray(['installed' => false, 'code_verified' => false, 'steps_done' => []]);

    $code = setupCode();
    $v = $spa->call('POST', '/api/v1/admin/setup/code:verify', ['code' => strtolower($code)]);
    assertMatchesContract(SW, 'post', '/api/v1/admin/setup/code:verify', 200, $v);
    expect($v->json('data.code_verified'))->toBeTrue()->and($v->json('data.steps_done'))->toBe(['code']);

    $p = $spa->call('PUT', '/api/v1/admin/setup/preferences', ['locale' => 'en', 'timezone' => 'Asia/Bangkok']);
    assertMatchesContract(SW, 'put', '/api/v1/admin/setup/preferences', 200, $p);
    expect($p->json('data'))->toMatchArray(['locale' => 'en', 'timezone' => 'Asia/Bangkok']);
    expect($spa->call('PUT', '/api/v1/admin/setup/preferences', ['locale' => 'fr', 'timezone' => 'Mars/Base'])->status())->toBe(422);

    $ad = $spa->post('/api/v1/admin/setup/admin', ['name' => 'Quản trị đầu tiên', 'email' => 'Root@Itso.Local',
        'password' => 'mat-khau-rat-dai-2026']);
    assertMatchesContract(SW, 'post', '/api/v1/admin/setup/admin', 201, $ad);
    $user = User::query()->where('email', 'root@itso.local')->firstOrFail();
    expect($user->roleKey())->toBe('SUPER_ADMIN')->and($user->locale)->toBe('en')->and($user->timezone)->toBe('Asia/Bangkok');
    $again = $spa->post('/api/v1/admin/setup/admin', ['name' => 'Người thứ hai', 'email' => 'b@itso.local', 'password' => 'mat-khau-rat-dai-2026']);
    assertMatchesContract(SW, 'post', '/api/v1/admin/setup/admin', 409, $again);

    // TOTP bắt buộc trước bước 3.
    $access = ['panel_domain' => 'panel.itso.local', 'panel_port' => 8443, 'entrance_path' => '/itso-a7k2',
        'allowlist' => ['10.10.5.0/24', '203.0.113.7', '2001:db8::/32']];
    expect($spa->call('PUT', '/api/v1/admin/setup/access', $access)->status())->toBe(403);
    $secret = (string) $spa->post('/api/v1/auth/mfa/totp:enroll')->json('data.secret');
    $spa->post('/api/v1/auth/mfa/totp:confirm', ['code' => Totp::at($secret, now()->getTimestamp()), 'method' => 'totp'])->assertNoContent();

    expect($spa->post('/api/v1/admin/setup:complete')->status())->toBe(409); // chưa lưu bước 3
    $bad = $spa->call('PUT', '/api/v1/admin/setup/access', ['panel_domain' => null, 'panel_port' => 22, 'entrance_path' => 'x',
        'allowlist' => ['999.1.1.1']]);
    assertMatchesContract(SW, 'put', '/api/v1/admin/setup/access', 422, $bad);
    expect(array_keys($bad->json('errors')))->toContain('panel_port', 'entrance_path', 'allowlist.0');
    $ac = $spa->call('PUT', '/api/v1/admin/setup/access', $access);
    assertMatchesContract(SW, 'put', '/api/v1/admin/setup/access', 200, $ac);
    expect($ac->json('data.access'))->toBe($access)->and($ac->json('data.steps_done'))->toBe(['code', 'language', 'admin', 'access']);

    $q = $spa->get('/api/v1/admin/setup/quota');
    assertMatchesContract(SW, 'get', '/api/v1/admin/setup/quota', 200, $q);

    $done = $spa->post('/api/v1/admin/setup:complete');
    assertMatchesContract(SW, 'post', '/api/v1/admin/setup:complete', 200, $done);
    expect($done->json('data.installed'))->toBeTrue();
    expect(AuditLog::query()->where('action', 'like', 'setup.%')->pluck('action')->all())
        ->toContain('setup.code_verified', 'setup.admin_created', 'setup.access_saved', 'setup.completed');

    // Đã khóa: mọi endpoint ghi → 410, status không lộ cấu hình.
    $st = $spa->get('/api/v1/admin/setup/status');
    expect($st->json('data'))->toMatchArray(['installed' => true, 'access' => null]);
    $gone = $spa->call('POST', '/api/v1/admin/setup/code:verify', ['code' => setupCode()]);
    assertMatchesContract(SW, 'post', '/api/v1/admin/setup/code:verify', 410, $gone);
    expect($gone->json('code'))->toBe('setup_completed');
    expect($spa->call('PUT', '/api/v1/admin/setup/access', $access)->status())->toBe(410)
        ->and($spa->post('/api/v1/admin/setup:complete')->status())->toBe(410)
        ->and($spa->get('/api/v1/admin/setup/quota')->status())->toBe(410)
        ->and(wizardSpa($this)->post('/api/v1/admin/setup/admin', ['name' => 'X Y', 'email' => 'x@itso.local', 'password' => 'mat-khau-rat-dai-2026'])->status())->toBe(410);
});

it('mã dùng một lần: dùng lại (phiên khác) → 409 setup_code_used; mã sai → 422; hết hạn/không có file → 409', function () {
    $code = setupCode();
    wizardSpa($this)->call('POST', '/api/v1/admin/setup/code:verify', ['code' => $code])->assertOk();
    $reuse = wizardSpa($this)->call('POST', '/api/v1/admin/setup/code:verify', ['code' => $code]);
    assertMatchesContract(SW, 'post', '/api/v1/admin/setup/code:verify', 409, $reuse);
    expect($reuse->json('code'))->toBe('setup_code_used');

    $wrong = wizardSpa($this)->call('POST', '/api/v1/admin/setup/code:verify', ['code' => 'AAAA-BBBB-CCCC']);
    assertMatchesContract(SW, 'post', '/api/v1/admin/setup/code:verify', 422, $wrong);
    expect(wizardSpa($this)->call('POST', '/api/v1/admin/setup/code:verify', ['code' => 'không-hợp-lệ'])->status())->toBe(422);

    $old = setupCode(-5);
    expect(wizardSpa($this)->call('POST', '/api/v1/admin/setup/code:verify', ['code' => $old])->json('code'))->toBe('setup_code_expired');
    config(['itso.setup_code_file' => '/nonexistent/setup-code.json']);
    expect(wizardSpa($this)->call('POST', '/api/v1/admin/setup/code:verify', ['code' => $old])->status())->toBe(409);
});

it('mã mới thay mã cũ: phiên đã xác minh bằng mã cũ mất quyền; bước 1–2 cần phiên đã xác minh (403)', function () {
    $spa = wizardSpa($this);
    $first = setupCode();
    $spa->call('POST', '/api/v1/admin/setup/code:verify', ['code' => $first])->assertOk();
    $other = wizardSpa($this);
    $other->call('POST', '/api/v1/admin/setup/code:verify', ['code' => setupCode()])->assertOk();
    $denied = $spa->call('PUT', '/api/v1/admin/setup/preferences', ['locale' => 'vi', 'timezone' => 'UTC']);
    assertMatchesContract(SW, 'put', '/api/v1/admin/setup/preferences', 403, $denied);
    expect($denied->json('code'))->toBe('setup_not_verified');
    expect(wizardSpa($this)->post('/api/v1/admin/setup/admin', ['name' => 'Ai Do', 'email' => 'a@itso.local', 'password' => 'mat-khau-rat-dai-2026'])->status())->toBe(403);
    expect($other->call('PUT', '/api/v1/admin/setup/preferences', ['locale' => 'vi', 'timezone' => 'UTC'])->status())->toBe(200);
});

it('nhập sai mã quá 10 lần → 429', function () {
    setupCode();
    $spa = wizardSpa($this);
    foreach (range(1, 10) as $_) {
        $spa->call('POST', '/api/v1/admin/setup/code:verify', ['code' => 'AAAA-BBBB-CCCC'])->assertStatus(422);
    }
    expect($spa->call('POST', '/api/v1/admin/setup/code:verify', ['code' => 'AAAA-BBBB-CCCC'])->status())->toBe(429);
});

it('panel đã có SUPER_ADMIN không do wizard tạo (cài cũ/seed) → wizard khóa 410', function () {
    User::factory()->superAdmin()->create();
    expect(app(SetupWizard::class)->installed())->toBeTrue();
    expect(wizardSpa($this)->get('/api/v1/admin/setup/status')->json('data.installed'))->toBeTrue();
    expect(wizardSpa($this)->call('POST', '/api/v1/admin/setup/code:verify', ['code' => setupCode()])->status())->toBe(410);
});

it('SA do wizard tạo chưa khóa wizard: còn mở cho tới bước hoàn tất', function () {
    $spa = wizardSpa($this);
    $spa->call('POST', '/api/v1/admin/setup/code:verify', ['code' => setupCode()])->assertOk();
    $spa->post('/api/v1/admin/setup/admin', ['name' => 'Quản trị', 'email' => 'w@itso.local', 'password' => 'mat-khau-rat-dai-2026'])->assertStatus(201);
    expect(app(SetupWizard::class)->installed())->toBeFalse()
        ->and($spa->get('/api/v1/admin/setup/status')->json('data'))->toMatchArray(['installed' => false, 'admin_created' => true,
            'admin_mfa_enabled' => false]);
});
