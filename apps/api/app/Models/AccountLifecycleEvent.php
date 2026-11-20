<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Lịch sử chuyển trạng thái account (append-only, trigger).
 *
 * @property int $id
 * @property int $hosting_account_id
 * @property string|null $from_state
 * @property string $to_state
 * @property string|null $reason
 * @property int|null $actor_user_id
 * @property int|null $job_id
 * @property Carbon $at
 */
class AccountLifecycleEvent extends Model
{
    protected $table = 'account_lifecycle_events';

    protected $guarded = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'at' => 'datetime',
        ];
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id');
    }

    /** @return BelongsTo<User, $this> */
    public function actor(): BelongsTo
    {
        return $this->belongsTo(User::class, 'actor_user_id');
    }
}
