<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\SessionKeys;
use App\Exceptions\ApiProblem;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** `itso.self`: thao tác chỉ chủ tài khoản được làm (mật khẩu, MFA, phiên) — chặn trong phiên giả danh. */
final class RejectImpersonation
{
    public function handle(Request $request, Closure $next): Response
    {
        if ($request->hasSession() && $request->session()->get(SessionKeys::IMPERSONATION_ID) !== null) {
            throw ApiProblem::forbidden('Phiên giả danh không được đổi mật khẩu, MFA hay phiên đăng nhập.');
        }

        return $next($request);
    }
}
