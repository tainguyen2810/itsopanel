<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

/** Gửi lỗi: thông điệp đã rút gọn, không chứa bí mật; retryable = được thử lại theo lịch 1/5/15 phút. */
final class SendFailure extends \RuntimeException
{
    public function __construct(string $message, public readonly ?int $responseCode = null, public readonly bool $retryable = true)
    {
        parent::__construct(mb_substr($message, 0, 300));
    }
}
