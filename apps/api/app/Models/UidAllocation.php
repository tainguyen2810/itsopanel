<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * UID hệ thống cấp cho account; không tái dùng trong 90 ngày sau khi release.
 *
 * @property int $id
 * @property int $server_id
 * @property int $uid
 * @property int|null $hosting_account_id
 * @property Carbon $allocated_at
 * @property Carbon|null $released_at
 */
class UidAllocation extends Model
{
    protected $table = 'uid_allocations';

    protected $guarded = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'allocated_at' => 'datetime',
            'released_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class, 'server_id');
    }
}
