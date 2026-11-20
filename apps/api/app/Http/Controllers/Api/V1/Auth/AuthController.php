<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Auth;

use App\Auth\LoginThrottle;
use App\Auth\MfaService;
use App\Auth\Realm;
use App\Auth\SessionKeys;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\UserPresenter;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;

/** /api/v1/auth: csrf, login, logout, me (contracts: tag Auth). */
final class AuthController
{
    public function __construct(
        private readonly LoginThrottle $throttle,
        private readonly MfaService $mfa,
        private readonly UserPresenter $present,
    ) {}

    /** Cookie XSRF-TOKEN-{REALM} do VerifyCsrf gắn vào mọi response. */
    public function csrf(): Response
    {
        return response()->noContent();
    }

    public function login(Request $request): JsonResponse
    {
        $in = $request->validate([
            'email' => ['required', 'string', 'email', 'max:254'],
            'password' => ['required', 'string', 'min:1', 'max:200'],
            'remember' => ['sometimes', 'boolean'],
        ]);
        $realm = Realm::of($request);
        $email = mb_strtolower(trim((string) $in['email']));
        $ip = (string) $request->ip();

        $wait = $this->throttle->lockedFor($realm, $email, $ip);
        if ($wait > 0) {
            throw ApiProblem::rateLimited($wait, 'Đăng nhập sai quá nhiều lần, thử lại sau.');
        }

        /** @var User|null $user */
        $user = User::query()->where('realm', $realm)->where('email', $email)->first();
        $ok = $user !== null && $user->status === 'active' && Hash::check((string) $in['password'], $user->password_hash);
        $this->throttle->record($realm, $email, $ip, $ok);
        if (! $ok) {
            // Sai email, sai mật khẩu, sai realm, tài khoản khóa: cùng một lỗi (không lộ tài khoản).
            throw ApiProblem::field('email', 'Email hoặc mật khẩu không đúng.');
        }
        if (Hash::needsRehash($user->password_hash)) {
            $user->password_hash = Hash::make((string) $in['password']);
        }
        $user->last_login_at = Carbon::now();
        $user->save();

        Auth::guard('web')->login($user);
        $session = $request->session();
        $session->put(SessionKeys::CREATED_AT, Carbon::now()->toIso8601String());
        $session->put(SessionKeys::REMEMBER, (bool) ($in['remember'] ?? false));
        $session->forget([SessionKeys::MFA_VERIFIED_AT, SessionKeys::STEP_UP_AT, SessionKeys::TOTP_PENDING]);
        $session->regenerateToken();

        $methods = $this->mfa->methods($user);
        $required = $methods !== [] || $user->roleKey() === 'SUPER_ADMIN';

        return response()->json(['data' => ['mfa_required' => $required, 'mfa_methods' => $methods]]);
    }

    public function logout(Request $request): Response
    {
        Auth::guard('web')->logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->noContent();
    }

    public function me(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        return response()->json(['data' => $this->present->me($user, $request)]);
    }
}
