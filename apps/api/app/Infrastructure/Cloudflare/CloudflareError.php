<?php

declare(strict_types=1);

namespace App\Infrastructure\Cloudflare;

/** Lỗi gọi API Cloudflare. `retryable`: 5xx, 429 hoặc lỗi mạng; 4xx khác là lỗi dữ liệu/token. */
final class CloudflareError extends \RuntimeException
{
    public function __construct(public readonly int $status, string $message, public readonly bool $retryable)
    {
        parent::__construct($message);
    }
}
