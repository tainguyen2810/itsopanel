<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Một lượt gửi thông báo qua kênh (hoặc email cá nhân khi channel_id NULL). payload không chứa bí mật.
 *
 * @property int $id
 * @property string $uuid
 * @property int|null $channel_id
 * @property int|null $recipient_user_id
 * @property int|null $alert_id
 * @property string $event_type
 * @property string $severity
 * @property string $title
 * @property array<string, mixed> $payload
 * @property string $state
 * @property int $attempts
 * @property string|null $error
 * @property int|null $response_code
 * @property Carbon|null $next_retry_at
 * @property Carbon|null $sent_at
 * @property int|null $resend_of_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read NotificationChannel|null $channel
 * @property-read User|null $recipient
 */
class NotificationDelivery extends Model
{
    protected $table = 'notification_deliveries';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['payload' => 'array', 'attempts' => 'integer', 'response_code' => 'integer', 'next_retry_at' => 'datetime',
            'sent_at' => 'datetime'];
    }

    /** @return BelongsTo<NotificationChannel, $this> */
    public function channel(): BelongsTo
    {
        return $this->belongsTo(NotificationChannel::class, 'channel_id');
    }

    /** @return BelongsTo<User, $this> */
    public function recipient(): BelongsTo
    {
        return $this->belongsTo(User::class, 'recipient_user_id');
    }
}
