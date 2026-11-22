<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Cảnh báo (D-102): pending → firing → resolved; một cảnh báo mở cho mỗi fingerprint (rule + đối tượng).
 *
 * @property int $id
 * @property string $uuid
 * @property int $rule_id
 * @property int|null $server_id
 * @property int|null $hosting_account_id
 * @property int|null $website_id
 * @property string $fingerprint
 * @property string $state
 * @property string $severity
 * @property float|null $value
 * @property string|null $message
 * @property Carbon $started_at
 * @property Carbon|null $firing_at
 * @property Carbon|null $resolved_at
 * @property int $below_count
 * @property int|null $acked_by_user_id
 * @property Carbon|null $acked_at
 * @property Carbon|null $silenced_until
 * @property string|null $silence_reason
 * @property Carbon|null $last_notified_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read AlertRule $rule
 * @property-read Server|null $server
 * @property-read User|null $ackedBy
 */
class Alert extends Model
{
    use HasPublicUuid;

    protected $table = 'alerts';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['value' => 'float', 'started_at' => 'datetime', 'firing_at' => 'datetime', 'resolved_at' => 'datetime',
            'acked_at' => 'datetime', 'silenced_until' => 'datetime', 'last_notified_at' => 'datetime', 'below_count' => 'integer'];
    }

    /** @return BelongsTo<AlertRule, $this> */
    public function rule(): BelongsTo
    {
        return $this->belongsTo(AlertRule::class, 'rule_id');
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class);
    }

    /** @return BelongsTo<User, $this> */
    public function ackedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'acked_by_user_id');
    }

    public function silenced(?Carbon $now = null): bool
    {
        return $this->silenced_until !== null && $this->silenced_until->gt($now ?? Carbon::now());
    }
}
