<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Domain\Data\FileService;
use App\Exceptions\ApiProblem;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Giới hạn kích thước body (ASVS V12.1/V13.1, Prompt 12.4): API JSON ≤ itso.max_body_kb (mặc định 2 MB); riêng PATCH
 * chunk upload File Manager ≤ một chunk (8 MB) + 1 MB. Kiểm theo Content-Length trước khi đọc body; không có
 * Content-Length (chunked) thì đo body thật.
 */
final class LimitRequestBody
{
    public function handle(Request $request, Closure $next): Response
    {
        if ($request->is('api/*') && ! in_array($request->getMethod(), ['GET', 'HEAD', 'OPTIONS'], true)) {
            $max = $request->isMethod('PATCH') && $request->is('api/v1/*/hosting-accounts/*/files/uploads/*')
                ? FileService::CHUNK + 1048576 : (int) config('itso.max_body_kb', 2048) * 1024;
            $len = $request->headers->get('Content-Length');
            $size = $len !== null && ctype_digit($len) ? (int) $len : strlen((string) $request->getContent());
            if ($size > $max) {
                throw new ApiProblem(413, 'payload_too_large', 'Yêu cầu quá lớn',
                    'Body tối đa '.intdiv($max, 1024).' KB cho endpoint này.');
            }
        }

        return $next($request);
    }
}
