<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Chấp nhận quy định sử dụng nội bộ.
 *
 * @property int $id
 * @property int $user_id
 * @property string $version
 * @property Carbon $accepted_at
 * @property string|null $ip_address
 */
class TosAcceptance extends Model
{
    protected $table = 'tos_acceptances';

    protected $guarded = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'accepted_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }
}
