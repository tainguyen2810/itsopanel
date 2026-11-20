<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Auth;

use App\Auth\MfaService;
use App\Auth\SessionKeys;
use App\Auth\Totp;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\UserPresenter;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\RateLimiter;

/** MFA: verify sau đăng nhập, step-up, đăng ký TOTP (enroll → confirm). */
final class MfaController
{
    private const MAX_TRIES_PER_MINUTE = 5;

    public function __construct(private readonly MfaService $mfa, private readonly UserPresenter $present) {}

    public function verify(Request $request): JsonResponse
    {
        [$method, $code] = $this->input($request);
        $user = Auth::guard('web')->user();
        if (! $user instanceof User) {
            throw ApiProblem::field('code', 'Phiên đăng nhập đã hết hạn, hãy đăng nhập lại.');
        }
        $this->attempt($request, $user, $method, $code);
        $now = Carbon::now()->toIso8601String();
        $request->session()->put(SessionKeys::MFA_VERIFIED_AT, $now);
        $request->session()->migrate(true);

        return response()->json(['data' => $this->present->me($user, $request)]);
    }

    public function stepUp(Request $request): JsonResponse
    {
        [$method, $code] = $this->input($request);
        /** @var User $user */
        $user = $request->user();
        if (! $this->mfa->enabled($user)) {
            throw ApiProblem::conflict('Chưa bật MFA: bật TOTP trước khi xác thực lại.');
        }
        $this->attempt($request, $user, $method, $code);
        $now = Carbon::now()->toIso8601String();
        $request->session()->put(SessionKeys::MFA_VERIFIED_AT, $now);
        $request->session()->put(SessionKeys::STEP_UP_AT, $now);

        return response()->json(['data' => $this->present->me($user, $request)]);
    }

    public function enroll(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();
        if ($this->mfa->enabled($user)) {
            throw ApiProblem::conflict('TOTP đã bật. Tắt/đặt lại MFA do quản trị viên thực hiện.');
        }
        $e = $this->mfa->startEnrollment();
        $request->session()->put(SessionKeys::TOTP_PENDING, $e['pending']);
        $issuer = (string) config('itso.auth.mfa_issuer', 'ITSO');

        return response()->json(['data' => [
            'secret' => $e['secret'],
            'otpauth_uri' => Totp::uri($issuer, $user->email, $e['secret']),
            'recovery_codes' => $e['codes'],
        ]]);
    }

    public function confirm(Request $request): Response
    {
        [$method, $code] = $this->input($request);
        /** @var User $user */
        $user = $request->user();
        if ($this->mfa->enabled($user)) {
            throw ApiProblem::conflict('TOTP đã bật.');
        }
        $pending = $request->session()->get(SessionKeys::TOTP_PENDING);
        if (! is_array($pending) || ! is_string($pending['secret'] ?? null) || ! is_array($pending['hashes'] ?? null)) {
            throw ApiProblem::conflict('Chưa bắt đầu đăng ký TOTP (POST /auth/mfa/totp:enroll).');
        }
        $this->limit($request, $user);
        /** @var array{secret: string, hashes: list<string>} $pending */
        if ($method !== 'totp' || ! $this->mfa->confirmEnrollment($user, $pending, $code)) {
            throw ApiProblem::field('code', 'Mã xác thực không đúng.');
        }
        RateLimiter::clear('mfa:'.$user->id);
        $request->session()->forget(SessionKeys::TOTP_PENDING);
        // Vừa chứng minh sở hữu thiết bị: coi như đã xác minh MFA trong phiên này.
        $request->session()->put(SessionKeys::MFA_VERIFIED_AT, Carbon::now()->toIso8601String());

        return response()->noContent();
    }

    /** @return array{0: string, 1: string} */
    private function input(Request $request): array
    {
        $in = $request->validate([
            'code' => ['required', 'string', 'regex:/^([0-9]{6}|[a-z0-9]{10})$/'],
            'method' => ['required', 'string', 'in:totp,recovery'],
        ]);

        return [(string) $in['method'], (string) $in['code']];
    }

    private function attempt(Request $request, User $user, string $method, string $code): void
    {
        $this->limit($request, $user);
        if (! $this->mfa->verify($user, $method, $code)) {
            throw ApiProblem::field('code', 'Mã xác thực không đúng.');
        }
        RateLimiter::clear('mfa:'.$user->id);
    }

    private function limit(Request $request, User $user): void
    {
        $key = 'mfa:'.$user->id;
        if (RateLimiter::tooManyAttempts($key, self::MAX_TRIES_PER_MINUTE)) {
            throw ApiProblem::rateLimited(RateLimiter::availableIn($key), 'Nhập sai mã quá nhiều lần, thử lại sau.');
        }
        RateLimiter::hit($key, 60);
    }
}
