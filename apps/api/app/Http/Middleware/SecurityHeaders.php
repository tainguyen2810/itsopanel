<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Header bảo mật cho mọi phản hồi của Laravel (ASVS V14.4, Prompt 12.4): lớp thứ hai sau Caddy, có hiệu lực cả khi
 * chạy sau proxy khác hoặc `artisan serve`. JSON của API không được cache (dữ liệu theo phiên).
 */
final class SecurityHeaders
{
    public function handle(Request $request, Closure $next): Response
    {
        /** @var Response $res */
        $res = $next($request);
        $h = $res->headers;
        $h->set('X-Content-Type-Options', 'nosniff');
        $h->set('X-Frame-Options', 'DENY');
        $h->set('Referrer-Policy', 'same-origin');
        if (! $h->has('Content-Security-Policy')) {
            $h->set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        }
        $type = (string) $h->get('Content-Type', '');
        if (str_contains($type, 'json')) {
            $h->set('Cache-Control', 'no-store, private');
        }
        $h->remove('X-Powered-By');

        return $res;
    }
}
