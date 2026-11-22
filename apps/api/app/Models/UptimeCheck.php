<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Uptime check của website (D-105): URL luôn là domain chính của website + `path`; agent của server chứa website
 * gọi qua op uptime.probe. state: up|down|unknown (paused = enabled false, chỉ ở API).
 *
 * @property int $id
 * @property string $uuid
 * @property int $website_id
 * @property string $path
 * @property string|null $keyword
 * @property int $interval_sec
 * @property bool $enabled
 * @property string $state
 * @property int $consecutive_failures
 * @property int|null $last_status
 * @property int|null $last_latency_ms
 * @property string|null $last_error
 * @property Carbon|null $last_checked_at
 * @property Carbon|null $down_since
 * @property Carbon|null $cert_expires_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Website $website
 */
class UptimeCheck extends Model
{
    use HasPublicUuid;

    protected $table = 'uptime_checks';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['enabled' => 'boolean', 'last_checked_at' => 'datetime', 'down_since' => 'datetime',
            'cert_expires_at' => 'datetime', 'consecutive_failures' => 'integer', 'interval_sec' => 'integer'];
    }

    /** @return BelongsTo<Website, $this> */
    public function website(): BelongsTo
    {
        return $this->belongsTo(Website::class);
    }
}
