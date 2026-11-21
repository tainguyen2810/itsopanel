<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Auth;

use App\Auth\Captcha;
use App\Auth\Realm;
use App\Auth\SessionRepository;
use App\Domain\Users\UserService;
use App\Exceptions\ApiProblem;
use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\RateLimiter;

/**
 * Đổi / quên / đặt lại mật khẩu. Token đặt lại: ngẫu nhiên 64 ký tự, chỉ lưu SHA-256 trong cache,
 * dùng một lần, hết hạn `itso.auth.password_reset_minutes` (60). Đổi/đặt lại xong thu hồi các phiên khác.
 */
final class PasswordController
{
    public function __construct(private readonly SessionRepository $sessions, private readonly UserService $users) {}

    public function change(Request $request): Response
    {
        $in = $request->validate([
            'current_password' => ['required', 'string', 'max:200'],
            'new_password' => ['required', 'string', 'min:12', 'max:200', 'different:current_password'],
        ]);
        /** @var User $user */
        $user = $request->user();
        if (! Hash::check((string) $in['current_password'], $user->password_hash)) {
            throw ApiProblem::field('current_password', 'Mật khẩu hiện tại không đúng.');
        }
        $user->password_hash = Hash::make((string) $in['new_password']);
        $user->must_change_password = false;
        $user->save();
        $request->session()->migrate(true);
        $this->sessions->deleteAllFor($user, $request->session()->getId());

        return response()->noContent();
    }

    public function forgot(Request $request): Response
    {
        $in = $request->validate(['email' => ['required', 'string', 'email', 'max:254'], 'captcha' => ['sometimes', 'array:challenge,nonce']]);
        $realm = Realm::of($request);
        $email = mb_strtolower(trim((string) $in['email']));
        app(Captcha::class)->enforce($realm, $email, (string) $request->ip(), $in['captcha'] ?? null);
        $key = 'pwforgot:'.$realm.':'.$email;
        if (RateLimiter::tooManyAttempts($key, 3)) {
            throw ApiProblem::rateLimited(RateLimiter::availableIn($key));
        }
        RateLimiter::hit($key, 900);

        /** @var User|null $user */
        $user = User::query()->where('realm', $realm)->where('email', $email)->where('status', 'active')->first();
        if ($user !== null) {
            $this->users->sendPasswordLink($user, (int) config('itso.auth.password_reset_minutes', 60));
        }

        return response()->noContent();
    }

    public function reset(Request $request): Response
    {
        $in = $request->validate([
            'token' => ['required', 'string', 'min:32', 'max:200'],
            'email' => ['required', 'string', 'email', 'max:254'],
            'password' => ['required', 'string', 'min:12', 'max:200'],
        ]);
        $realm = Realm::of($request);
        /** @var User|null $user */
        $user = User::query()->where('realm', $realm)->where('email', mb_strtolower(trim((string) $in['email'])))->first();
        $stored = $user !== null ? Cache::get(self::cacheKey($user)) : null;
        if ($user === null || ! is_string($stored) || ! hash_equals($stored, hash('sha256', (string) $in['token']))) {
            throw ApiProblem::field('token', 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.');
        }
        Cache::forget(self::cacheKey($user));
        $user->password_hash = Hash::make((string) $in['password']);
        $user->must_change_password = false;
        $user->save();
        $this->sessions->deleteAllFor($user);

        return response()->noContent();
    }

    private static function cacheKey(User $user): string
    {
        return UserService::resetCacheKey($user);
    }
}
