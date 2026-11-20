<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/** Gắn X-Request-Id (nhận từ proxy nếu hợp lệ, không thì sinh mới) cho log và Problem. */
final class AssignRequestId
{
    public function handle(Request $request, Closure $next): Response
    {
        $incoming = $request->headers->get('X-Request-Id');
        $id = is_string($incoming) && preg_match('/^[A-Za-z0-9._-]{8,64}$/', $incoming) === 1
            ? $incoming
            : 'req_'.Str::ulid()->toBase32();
        $request->attributes->set('request_id', $id);

        /** @var Response $response */
        $response = $next($request);
        $response->headers->set('X-Request-Id', $id);

        return $response;
    }
}
