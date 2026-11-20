<?php

declare(strict_types=1);

namespace App\Domain\Users;

use App\Auth\SessionRepository;
use App\Exceptions\ApiProblem;
use App\Mail\PasswordResetMail;
use App\Models\Role;
use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;

/** Nghiệp vụ người dùng dùng chung cho Admin API và (sau này) CLI. */
final class UserService
{
    public function __construct(private readonly SessionRepository $sessions) {}

    public static function resetCacheKey(User $user): string
    {
        return 'itso:pwreset:'.$user->id;
    }

    /** Tạo token đặt mật khẩu và gửi mail (quên mật khẩu, mời user mới). */
    public function sendPasswordLink(User $user, int $minutes): void
    {
        $token = Str::random(64);
        Cache::put(self::resetCacheKey($user), hash('sha256', $token), now()->addMinutes($minutes));
        $base = rtrim((string) config("itso.auth.app_urls.{$user->realm}"), '/');
        $url = $base.'/reset-password?'.http_build_query(['token' => $token, 'email' => $user->email]);
        Mail::to($user->email)->send(new PasswordResetMail($user->name, $url, $minutes));
    }

    public function setRole(User $user, string $roleKey): void
    {
        $role = Role::query()->where('key', $roleKey)->firstOrFail();
        DB::table('user_roles')->updateOrInsert(['user_id' => $user->id],
            ['role_id' => $role->id, 'updated_at' => now(), 'created_at' => now()]);
        $user->unsetRelation('roles');
    }

    /** Mật khẩu ngẫu nhiên không ai biết (user đặt mật khẩu qua link mời / quên mật khẩu). */
    public static function unusablePassword(): string
    {
        return Hash::make(Str::random(48));
    }

    /** Chặn thao tác làm hệ thống không còn SUPER_ADMIN đang hoạt động. */
    public function guardLastSuperAdmin(User $target): void
    {
        if ($target->roleKey() !== 'SUPER_ADMIN' || $target->status !== 'active') {
            return;
        }
        $others = User::query()->where('status', 'active')->where('id', '!=', $target->id)
            ->whereHas('roles', fn ($q) => $q->where('key', 'SUPER_ADMIN'))->lockForUpdate()->pluck('id');
        if ($others->isEmpty()) {
            throw ApiProblem::conflict('Phải luôn còn ít nhất một SUPER_ADMIN đang hoạt động.');
        }
    }

    public function revokeSessions(User $user): void
    {
        $this->sessions->deleteAllFor($user);
    }
}
