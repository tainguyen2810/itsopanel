<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Phiên đăng nhập thay (SA → USER), có lý do.
 *
 * @property int $id
 * @property int $staff_user_id
 * @property int $target_user_id
 * @property string $reason
 * @property Carbon $started_at
 * @property Carbon|null $ended_at
 * @property Carbon $expires_at
 */
class ImpersonationSession extends Model
{
    protected $table = 'impersonation_sessions';

    protected $guarded = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'started_at' => 'datetime',
            'ended_at' => 'datetime',
            'expires_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function staff(): BelongsTo
    {
        return $this->belongsTo(User::class, 'staff_user_id');
    }

    /** @return BelongsTo<User, $this> */
    public function target(): BelongsTo
    {
        return $this->belongsTo(User::class, 'target_user_id');
    }
}
