<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

use App\Models\Notification;
use App\Models\User;

/**
 * Thông báo tới một người (giữ API cũ): đi qua NotificationDispatcher — in-app như trước (trừ khi người nhận tắt và sự kiện
 * không phải critical), thêm email cá nhân / Telegram theo tùy chọn (Phase 11, D-104).
 */
class Notifier
{
    public const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

    public function __construct(private readonly NotificationDispatcher $dispatcher) {}

    public function notify(User $user, string $type, string $title, string $body = '', string $severity = 'info',
        ?string $link = null): ?Notification
    {
        return $this->dispatcher->toUser($user, $type, $title, $body, $severity, $link);
    }
}
