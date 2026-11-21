<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\ApiTokenAuth;
use App\Auth\MfaService;
use App\Auth\Realm;
use App\Auth\SessionKeys;
use App\Domain\Setup\Settings;
use App\Exceptions\ApiProblem;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * `itso.mfa`: phiên của user đã bật TOTP phải xác minh MFA; SUPER_ADMIN chưa bật MFA bị chặn mọi thao tác
 * (chỉ còn /auth/me, đăng ký TOTP, đăng xuất). Token API (máy) không qua MFA.
 */
final class RequireMfa
{
    public function __construct(private readonly MfaService $mfa) {}

    public function handle(Request $request, Closure $next): Response
    {
        if ($request->attributes->has(ApiTokenAuth::ATTRIBUTE)) {
            return $next($request);
        }
        $user = $request->user();
        if (! $user instanceof User) {
            throw ApiProblem::unauthenticated();
        }
        if ($this->mfa->enabled($user)) {
            if ($request->session()->get(SessionKeys::MFA_VERIFIED_AT) === null) {
                throw ApiProblem::mfaRequired('Nhập mã MFA để tiếp tục (POST /auth/mfa/verify).');
            }
        } elseif ($user->roleKey() === 'SUPER_ADMIN') {
            throw ApiProblem::mfaRequired('SUPER_ADMIN phải bật MFA trước khi thao tác (POST /auth/mfa/totp:enroll).');
        } elseif ($user->realm === Realm::PORTAL && Settings::get('security', 'portal_mfa_required') === true) {
            // ADR 0028 §2: hệ thống bắt buộc USER bật MFA.
            throw ApiProblem::mfaRequired('Hệ thống yêu cầu bật MFA trước khi thao tác (POST /auth/mfa/totp:enroll).');
        }

        return $next($request);
    }
}
