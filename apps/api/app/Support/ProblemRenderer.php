<?php

declare(strict_types=1);

namespace App\Support;

use App\Exceptions\ApiProblem;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Http\Exceptions\ThrottleRequestsException;
use Illuminate\Http\JsonResponse;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Symfony\Component\HttpKernel\Exception\MethodNotAllowedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Throwable;

/**
 * Chuyển mọi exception của /api/* thành application/problem+json.
 */
final class ProblemRenderer
{
    public static function render(Throwable $e): JsonResponse
    {
        return match (true) {
            $e instanceof ApiProblem => Problem::response($e->status, $e->problemCode, $e->title, $e->detail,
                $e->errors, $e->headers),
            $e instanceof ValidationException => Problem::response(422, 'validation_failed', 'Dữ liệu không hợp lệ',
                'Một hoặc nhiều trường không hợp lệ.', self::errors($e)),
            $e instanceof AuthenticationException => Problem::response(401, 'unauthenticated', 'Chưa đăng nhập'),
            $e instanceof AuthorizationException,
            $e instanceof AccessDeniedHttpException => Problem::response(403, 'forbidden', 'Không có quyền'),
            $e instanceof NotFoundHttpException => Problem::response(404, 'not_found', 'Không tìm thấy',
                'Tài nguyên không tồn tại hoặc ngoài phạm vi.'),
            $e instanceof MethodNotAllowedHttpException => Problem::response(405, 'bad_request',
                'Phương thức không được hỗ trợ', null, null, self::headers($e)),
            $e instanceof ThrottleRequestsException => Problem::response(429, 'rate_limited', 'Quá nhiều yêu cầu',
                null, null, self::headers($e)),
            $e instanceof HttpExceptionInterface => self::http($e),
            default => Problem::response(500, 'internal_error', 'Lỗi máy chủ',
                config('app.debug') === true ? $e->getMessage() : null),
        };
    }

    private static function http(HttpExceptionInterface $e): JsonResponse
    {
        $status = $e->getStatusCode();
        [$code, $title] = match ($status) {
            400 => ['bad_request', 'Yêu cầu không hợp lệ'],
            401 => ['unauthenticated', 'Chưa đăng nhập'],
            403 => ['forbidden', 'Không có quyền'],
            404 => ['not_found', 'Không tìm thấy'],
            409 => ['conflict', 'Xung đột'],
            412 => ['precondition_failed', 'Phiên bản đã thay đổi'],
            419 => ['csrf_mismatch', 'CSRF token không hợp lệ'],
            423 => ['resource_locked', 'Tài nguyên đang bị khóa'],
            429 => ['rate_limited', 'Quá nhiều yêu cầu'],
            503 => ['agent_unavailable', 'Dịch vụ tạm thời không sẵn sàng'],
            default => [$status >= 500 ? 'internal_error' : 'bad_request', 'Lỗi'],
        };
        $status = max(400, min(599, $status));

        return Problem::response($status, $code, $title, null, null, self::headers($e));
    }

    /** @return array<string, list<string>> */
    private static function errors(ValidationException $e): array
    {
        $out = [];
        foreach ($e->errors() as $field => $messages) {
            $out[(string) $field] = array_values(array_map('strval', $messages));
        }

        return $out;
    }

    /** @return array<string, string> */
    private static function headers(HttpExceptionInterface $e): array
    {
        $out = [];
        foreach ($e->getHeaders() as $k => $v) {
            if (in_array(strtolower((string) $k), ['allow', 'retry-after'], true)) {
                $out[(string) $k] = is_array($v) ? implode(', ', array_map('strval', $v)) : (string) $v;
            }
        }

        return $out;
    }
}
