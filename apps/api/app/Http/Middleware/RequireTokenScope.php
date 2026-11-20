<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\ApiTokenAuth;
use App\Exceptions\ApiProblem;
use App\Models\ApiToken;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** `itso.scope:servers:read`: request bằng API token phải có scope; phiên cookie bỏ qua (RBAC kiểm riêng). */
final class RequireTokenScope
{
    public function handle(Request $request, Closure $next, string $scope): Response
    {
        $token = $request->attributes->get(ApiTokenAuth::ATTRIBUTE);
        if ($token instanceof ApiToken && ! ApiTokenAuth::allows($token, $scope)) {
            throw ApiProblem::forbidden("Token thiếu scope $scope.");
        }

        return $next($request);
    }
}
