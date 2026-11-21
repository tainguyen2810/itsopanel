<?php

use App\Models\AuditLog;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

// Prompt 4.4: lệnh artisan cho `itso admin reset-password|reset-mfa` (CLI gọi bằng argv cố định).

it('itso:admin-reset-password: mật khẩu tạm, bắt đổi, thu hồi phiên, ghi audit; chỉ realm admin', function () {
    $u = User::factory()->superAdmin()->create(['email' => 'qt@example.vn']);
    DB::table('sessions')->insert(['id' => 'sess-1', 'user_id' => $u->id, 'realm' => 'admin', 'payload' => '', 'last_activity' => time()]);
    $old = $u->password_hash;

    $this->artisan('itso:admin-reset-password', ['--email' => 'QT@example.vn'])
        ->expectsOutputToContain('Đã đặt mật khẩu tạm cho qt@example.vn')
        ->assertSuccessful();

    $u->refresh();
    expect($u->password_hash)->not->toBe($old)
        ->and($u->must_change_password)->toBeTrue()
        ->and(DB::table('sessions')->where('user_id', $u->id)->count())->toBe(0)
        ->and(AuditLog::query()->where('action', 'user.password_reset_cli')->where('resource_id', $u->id)->exists())->toBeTrue();
    expect(json_encode(AuditLog::query()->where('action', 'user.password_reset_cli')->value('changes')))->not->toContain('password_hash');

    $portal = User::factory()->portalUser()->create(['email' => 'kh@example.vn']);
    $this->artisan('itso:admin-reset-password', ['--email' => 'kh@example.vn'])->assertFailed();
    expect(Hash::check('x', $portal->refresh()->password_hash))->toBeFalse();
    $this->artisan('itso:admin-reset-password', ['--email' => 'khong-hop-le'])->assertFailed();
    $this->artisan('itso:admin-reset-password')->assertFailed();
});

it('itso:admin-reset-mfa: gỡ MFA, thu hồi phiên, ghi audit', function () {
    $u = User::factory()->admin()->create(['email' => 'mfa@example.vn']);
    $u->mfaCredentials()->create(['type' => 'totp', 'secret_encrypted' => 'x']);
    DB::table('sessions')->insert(['id' => 'sess-2', 'user_id' => $u->id, 'realm' => 'admin', 'payload' => '', 'last_activity' => time()]);

    $this->artisan('itso:admin-reset-mfa', ['--email' => 'mfa@example.vn'])
        ->expectsOutputToContain('Đã gỡ 1 phương thức MFA')
        ->assertSuccessful();

    expect($u->mfaCredentials()->count())->toBe(0)
        ->and(DB::table('sessions')->where('user_id', $u->id)->count())->toBe(0)
        ->and(AuditLog::query()->where('action', 'user.mfa_reset_cli')->exists())->toBeTrue();
    $this->artisan('itso:admin-reset-mfa', ['--email' => 'khongco@example.vn'])->assertFailed();
});
