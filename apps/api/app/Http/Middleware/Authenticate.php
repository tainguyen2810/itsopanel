<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\ApiTokenAuth;
use App\Auth\Realm;
use App\Exceptions\ApiProblem;
use App\Models\User;
use Closure;
use Illuminate\Auth\AuthManager;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * `itso.auth[:admin|portal]`: Bearer token (chỉ realm admin) hoặc phiên cookie của đúng realm.
 * User phải cùng realm với request và còn `active`; phiên của user bị khóa bị đăng xuất.
 */
final class Authenticate
{
    public function __construct(private readonly AuthManager $auth) {}

    public function handle(Request $request, Closure $next, ?string $realm = null): Response
    {
        $realm ??= Realm::of($request);
        if ($request->bearerToken() !== null) {
            $user = $realm === Realm::ADMIN ? ApiTokenAuth::user($request) : null;
            if ($user === null) {
                throw ApiProblem::unauthenticated('Token không hợp lệ, hết hạn hoặc ngoài CIDR cho phép.');
            }
            $this->auth->shouldUse('token');
            $this->auth->guard('token')->setUser($user);

            return $next($request);
        }

        $user = $this->auth->guard('web')->user();
        if (! $user instanceof User || $user->realm !== $realm || Realm::of($request) !== $realm) {
            throw ApiProblem::unauthenticated();
        }
        if ($user->status !== 'active') {
            $this->auth->guard('web')->logout();
            $request->session()->invalidate();
            throw ApiProblem::unauthenticated('Tài khoản đã bị khóa hoặc vô hiệu hóa.');
        }

        return $next($request);
    }
}
