<?php

declare(strict_types=1);

namespace App\Domain\Monitoring;

use App\Domain\Notifications\NotificationDispatcher;
use App\Models\Alert;
use App\Models\NotificationChannel;

/**
 * Sự kiện chuyển trạng thái cảnh báo (firing, nhắc lại, resolved) → thông báo (D-102/D-104).
 * - SUPER_ADMIN + ADMIN có server/account trong phạm vi: in-app / email cá nhân theo tùy chọn, giới hạn bởi `channels` của rule;
 *   mức critical luôn có in-app.
 * - Loại kênh admin trong `channels` của rule (email nhóm, Telegram, webhook) → mọi kênh đang bật của loại đó
 *   (thu hẹp theo `channel_ids` nếu có) → notification_deliveries qua queue.
 * USER chủ account nhận sự kiện nghiệp vụ riêng (website.down/up, quota.*, certificate.*, backup.failed), không nhận cảnh báo rule.
 * Nội dung không chứa bí mật.
 */
class AlertEvents
{
    public function __construct(protected readonly NotificationDispatcher $dispatcher) {}

    /** @param  'firing'|'repeat'|'resolved'  $event */
    public function emit(Alert $alert, string $event): void
    {
        $rule = $alert->rule;
        $prefix = match ($event) {
            'firing' => 'Cảnh báo',
            'repeat' => 'Nhắc lại',
            default => 'Đã hết',
        };
        $title = mb_substr("$prefix: {$rule->name}", 0, 200);
        $body = (string) $alert->message;
        $severity = $event === 'resolved' ? 'info' : $alert->severity;
        $type = "alert.$event";
        $personal = array_values(array_intersect($rule->channels, ['in_app', 'email']));
        if ($personal !== [] || $alert->severity === 'critical') {
            foreach ($this->dispatcher->admins($alert->server_id, $alert->hosting_account_id) as $u) {
                $this->dispatcher->toUser($u, $type, $title, $body, $severity, '/monitoring/alerts', $personal);
            }
        }
        $types = array_values(array_intersect($rule->channels, ['email', 'telegram', 'webhook']));
        if ($types !== []) {
            $q = NotificationChannel::query()->whereIn('type', $types)->where('enabled', true)->orderBy('id');
            if ($rule->channel_ids !== []) {
                $q->whereIn('id', $rule->channel_ids);
            }
            foreach ($q->get() as $c) {
                $this->dispatcher->toChannel($c, $type, $title, $body, $severity, '/monitoring/alerts', $alert->id);
            }
        }
    }
}
