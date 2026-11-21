<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Thay đổi file hệ thống so với baseline FIM (ADR 0027).
 *
 * @property int $id
 * @property string $uuid
 * @property int $server_id
 * @property string $path
 * @property string $change
 * @property string|null $old_sha256
 * @property string|null $new_sha256
 * @property int|null $mode
 * @property string|null $owner
 * @property Carbon $detected_at
 * @property int|null $acknowledged_by_user_id
 * @property Carbon|null $acknowledged_at
 * @property-read Server $server
 */
class FimChange extends Model
{
    use HasPublicUuid;

    protected $table = 'fim_changes';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return ['detected_at' => 'datetime', 'acknowledged_at' => 'datetime'];
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class);
    }
}
