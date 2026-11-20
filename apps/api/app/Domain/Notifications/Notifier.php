<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

use App\Models\Notification;
use App\Models\User;
use Illuminate\Support\Carbon;

/** Thông báo in-app (bảng notifications). Kênh email/Telegram: Phase 11. */
final class Notifier
{
    public const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

    public function notify(User $user, string $type, string $title, string $body = '', string $severity = 'info',
        ?string $link = null): Notification
    {
        return Notification::query()->create([
            'user_id' => $user->id, 'type' => $type, 'title' => mb_substr($title, 0, 200), 'body' => mb_substr($body, 0, 2000),
            'data' => ['severity' => in_array($severity, self::SEVERITIES, true) ? $severity : 'info', 'link' => $link],
            'created_at' => Carbon::now(),
        ]);
    }
}
