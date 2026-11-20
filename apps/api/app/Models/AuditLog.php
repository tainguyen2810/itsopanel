<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Nhật ký kiểm toán: append-only + hash chain (trigger).
 *
 * @property int|null $id
 * @property Carbon $at
 * @property int|null $actor_user_id
 * @property int|null $impersonator_user_id
 * @property string|null $actor_ip
 * @property string|null $user_agent
 * @property string $action
 * @property string|null $resource_type
 * @property int|null $resource_id
 * @property int|null $server_id
 * @property int|null $job_id
 * @property array<array-key, mixed>|null $changes
 * @property string $result
 * @property string|null $prev_hash
 * @property string|null $hash
 */
class AuditLog extends Model
{
    protected $table = 'audit_logs';

    protected $guarded = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'changes' => 'array',
            'at' => 'datetime',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_user_id');
    }
}
