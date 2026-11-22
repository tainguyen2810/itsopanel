<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Domain\Notifications\NotificationSender;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** Worker queue `notifications` gửi một delivery (ADR 0048 §4). Thử lại do NotificationSender lên lịch, không dùng retry của queue. */
final class SendNotification implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(public readonly int $deliveryId)
    {
        $this->onQueue('notifications');
    }

    public function handle(NotificationSender $sender): void
    {
        $sender->attempt($this->deliveryId);
    }
}
