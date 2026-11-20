<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Auth\Realm;
use Illuminate\Foundation\Http\Middleware\PreventRequestForgery;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Cookie;

/**
 * CSRF double-submit (D-58): cookie XSRF-TOKEN-ADMIN / XSRF-TOKEN-PORTAL (tách theo realm để hai SPA chung origin
 * không ghi đè nhau), client gửi lại qua header X-XSRF-TOKEN. Thiếu/sai → 419 csrf_mismatch.
 * Request dùng Bearer token không mang cookie phiên nên không cần CSRF. Kiểm cả khi chạy test.
 */
final class VerifyCsrf extends PreventRequestForgery
{
    public function handle($request, \Closure $next)
    {
        if ($request->bearerToken() !== null && ! $request->cookies->has(Realm::cookie(Realm::of($request)))) {
            return $next($request);
        }

        return parent::handle($request, $next);
    }

    protected function runningUnitTests()
    {
        return false;
    }

    /** Sec-Fetch-Site chỉ là lớp bổ sung; luôn yêu cầu token. */
    protected function hasValidOrigin($request)
    {
        return false;
    }

    /**
     * @param  Request  $request
     * @param  array<string, mixed>  $config
     */
    protected function newCookie($request, $config)
    {
        return new Cookie(
            Realm::xsrfCookie(Realm::of($request)),
            $request->session()->token(),
            $this->availableAt(60 * $config['lifetime']),
            $config['path'],
            $config['domain'],
            $config['secure'],
            false,
            false,
            $config['same_site'] ?? null,
            $config['partitioned'] ?? false
        );
    }
}
