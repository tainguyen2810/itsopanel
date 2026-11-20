<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Agent trên server (Phase 3: local, mock).
 *
 * @property int $id
 * @property int $server_id
 * @property string|null $version
 * @property string $transport
 * @property string|null $cert_fingerprint
 * @property Carbon|null $cert_expires_at
 * @property array<array-key, mixed> $capabilities
 * @property Carbon|null $last_seen_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Agent extends Model
{
    protected $table = 'agents';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return [
            'capabilities' => 'array',
            'last_seen_at' => 'datetime',
            'cert_expires_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class, 'server_id');
    }
}
