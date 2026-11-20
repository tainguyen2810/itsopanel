<?php

declare(strict_types=1);

namespace App\Exceptions;

use RuntimeException;

/**
 * Lỗi nghiệp vụ trả thẳng RFC 9457 (code thuộc ErrorCode trong contracts/openapi/common.yaml).
 */
final class ApiProblem extends RuntimeException
{
    /**
     * @param  array<string, list<string>>|null  $errors
     * @param  array<string, string>  $headers
     */
    public function __construct(
        public readonly int $status,
        public readonly string $problemCode,
        public readonly string $title,
        public readonly ?string $detail = null,
        public readonly ?array $errors = null,
        public readonly array $headers = [],
    ) {
        parent::__construct($title);
    }

    public static function unauthenticated(?string $detail = null): self
    {
        return new self(401, 'unauthenticated', 'Chưa đăng nhập', $detail);
    }

    public static function forbidden(?string $detail = null): self
    {
        return new self(403, 'forbidden', 'Không có quyền', $detail);
    }

    public static function mfaRequired(string $detail): self
    {
        return new self(403, 'mfa_required', 'Cần xác thực MFA', $detail);
    }

    public static function stepUpRequired(): self
    {
        return new self(403, 'mfa_step_up_required', 'Cần xác thực lại MFA',
            'Thao tác nhạy cảm: xác thực lại bằng mã MFA (POST /auth/step-up).');
    }

    public static function conflict(string $detail): self
    {
        return new self(409, 'conflict', 'Xung đột', $detail);
    }

    /** 422 với lỗi gắn vào một trường. */
    public static function field(string $field, string $message): self
    {
        return new self(422, 'validation_failed', 'Dữ liệu không hợp lệ', 'Một hoặc nhiều trường không hợp lệ.',
            [$field => [$message]]);
    }

    public static function rateLimited(int $retryAfter, ?string $detail = null): self
    {
        return new self(429, 'rate_limited', 'Quá nhiều yêu cầu', $detail, null,
            ['Retry-After' => (string) max(1, $retryAfter)]);
    }
}
