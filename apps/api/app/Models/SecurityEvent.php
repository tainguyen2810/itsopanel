<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Sự kiện bảo mật (Phase 7): firewall/sshd hoàn tác, mã độc, FIM, WAF chặn nhiều, đăng nhập bất thường.
 *
 * @property int $id
 * @property string $uuid
 * @property int|null $server_id
 * @property int|null $website_id
 * @property string $type
 * @property string $severity
 * @property string|null $source_ip
 * @property string $message
 * @property array<string, mixed>|null $details
 * @property int|null $acknowledged_by_user_id
 * @property Carbon|null $acknowledged_at
 * @property Carbon $at
 * @property-read Server|null $server
 * @property-read Website|null $website
 */
class SecurityEvent extends Model
{
    use HasPublicUuid;

    protected $table = 'security_events';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return ['details' => 'array', 'acknowledged_at' => 'datetime', 'at' => 'datetime'];
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class);
    }

    /** @return BelongsTo<Website, $this> */
    public function website(): BelongsTo
    {
        return $this->belongsTo(Website::class)->withTrashed();
    }
}
