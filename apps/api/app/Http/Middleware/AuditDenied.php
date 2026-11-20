<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Domain\Audit\AuditLogger;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Ghi audit `result = denied` khi thao tác thay đổi (POST/PUT/PATCH/DELETE) của user đã đăng nhập bị từ chối 403
 * (thiếu quyền, thiếu step-up, đang giả danh…). Không ghi 404 ngoài phạm vi để tránh lộ thông tin qua log.
 */
final class AuditDenied
{
    public function __construct(private readonly AuditLogger $audit) {}

    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);
        if ($response->getStatusCode() === 403 && ! $request->isMethodSafe() && $request->user() instanceof User) {
            $body = json_decode((string) $response->getContent(), true);
            $this->audit->record('access.denied', null, [
                'method' => $request->method(),
                'path' => '/'.$request->path(),
                'code' => is_array($body) && is_string($body['code'] ?? null) ? $body['code'] : 'forbidden',
            ], 'denied');
        }

        return $response;
    }
}
