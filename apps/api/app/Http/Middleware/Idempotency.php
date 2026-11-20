<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Exceptions\ApiProblem;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\Response;

/**
 * `itso.idempotent`: header Idempotency-Key (uuid) bắt buộc cho POST tạo job. Lưu 24 giờ theo (user, key):
 * cùng key + cùng request → trả lại response cũ (header Idempotent-Replayed: true), khác request → 409
 * idempotency_key_reused. Chỉ lưu response 2xx; lỗi không giữ key để client sửa rồi gửi lại.
 */
final class Idempotency
{
    private const TTL_SECONDS = 86400;

    public function handle(Request $request, Closure $next): Response
    {
        $key = $request->header('Idempotency-Key');
        if (! is_string($key) || ! Str::isUuid($key)) {
            throw ApiProblem::field('Idempotency-Key', 'Thiếu header Idempotency-Key (UUID).');
        }
        $user = $request->user();
        $owner = $user !== null ? 'u'.$user->getAuthIdentifier() : 'ip'.$request->ip();
        $cacheKey = 'itso:idem:'.$owner.':'.strtolower($key);
        $fingerprint = hash('sha256', $request->method().' '.$request->path()."\n".$request->getContent());

        $lock = Cache::lock($cacheKey.':lock', 30);
        if (! $lock->get()) {
            throw ApiProblem::conflict('Yêu cầu cùng Idempotency-Key đang được xử lý.');
        }
        try {
            $saved = Cache::get($cacheKey);
            if (is_array($saved)) {
                if (! hash_equals((string) $saved['fp'], $fingerprint)) {
                    throw new ApiProblem(409, 'idempotency_key_reused', 'Idempotency-Key đã dùng cho yêu cầu khác',
                        'Mỗi Idempotency-Key chỉ dùng cho một nội dung yêu cầu.');
                }

                return response((string) $saved['body'], (int) $saved['status'], [
                    'Content-Type' => (string) $saved['type'], 'Idempotent-Replayed' => 'true',
                ]);
            }
            $response = $next($request);
            if ($response->getStatusCode() >= 200 && $response->getStatusCode() < 300) {
                Cache::put($cacheKey, [
                    'fp' => $fingerprint, 'status' => $response->getStatusCode(),
                    'type' => (string) $response->headers->get('Content-Type', 'application/json'),
                    'body' => (string) $response->getContent(),
                ], self::TTL_SECONDS);
            }

            return $response;
        } finally {
            $lock->release();
        }
    }
}
