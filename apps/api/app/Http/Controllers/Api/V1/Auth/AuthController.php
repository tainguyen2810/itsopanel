<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Auth;

use App\Auth\AuthFailureLog;
use App\Auth\Captcha;
use App\Auth\LoginThrottle;
use App\Auth\MfaService;
use App\Auth\Realm;
use App\Auth\SessionKeys;
use App\Domain\Setup\Settings;
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
        private readonly Captcha $captcha,
    ) {}

    /** Thử thách CAPTCHA proof-of-work (ADR 0028): dùng một lần, 5 phút. */
    public function captcha(Request $request): JsonResponse
    {
        return response()->json(['data' => $this->captcha->issue(Realm::of($request))])->header('Cache-Control', 'no-store');
    }

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
            'captcha' => ['sometimes', 'array:challenge,nonce'],
        ]);
        $realm = Realm::of($request);
        $email = mb_strtolower(trim((string) $in['email']));
        $ip = (string) $request->ip();

        $wait = $this->throttle->lockedFor($realm, $email, $ip);
        if ($wait > 0) {
            throw ApiProblem::rateLimited($wait, 'Đăng nhập sai quá nhiều lần, thử lại sau.');
        }
        $this->captcha->enforce($realm, $email, $ip, $in['captcha'] ?? null);

        /** @var User|null $user */
        $user = User::query()->where('realm', $realm)->where('email', $email)->first();
        $ok = $user !== null && $user->status === 'active' && Hash::check((string) $in['password'], $user->password_hash);
        $this->throttle->record($realm, $email, $ip, $ok);
        if (! $ok) {
            AuthFailureLog::failed($ip);
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
        $required = $methods !== [] || $user->roleKey() === 'SUPER_ADMIN'
            || ($user->realm === Realm::PORTAL && Settings::get('security', 'portal_mfa_required') === true);

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
