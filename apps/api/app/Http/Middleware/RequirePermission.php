<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\Access;
use App\Auth\ApiTokenAuth;
use App\Auth\Permissions;
use App\Exceptions\ApiProblem;
use App\Models\ApiToken;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * `itso.perm:users.read`: user phải có quyền (wildcard theo App\Auth\Permissions); request bằng API token
 * còn phải có scope tương ứng (`users:read`, hành động ghi → `users:write`). Thiếu → 403 forbidden.
 */
final class RequirePermission
{
    public function __construct(private readonly Access $access) {}

    public function handle(Request $request, Closure $next, string $permission): Response
    {
        $user = $request->user();
        if (! $user instanceof User) {
            throw ApiProblem::unauthenticated();
        }
        if (! $this->access->can($user, $permission)) {
            throw ApiProblem::forbidden("Thiếu quyền $permission.");
        }
        $token = $request->attributes->get(ApiTokenAuth::ATTRIBUTE);
        if ($token instanceof ApiToken && ! ApiTokenAuth::allows($token, Permissions::tokenScope($permission))) {
            throw ApiProblem::forbidden('Token thiếu scope '.Permissions::tokenScope($permission).'.');
        }

        return $next($request);
    }
}
