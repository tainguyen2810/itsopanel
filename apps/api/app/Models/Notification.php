<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Thông báo in-app.
 *
 * @property int $id
 * @property int $user_id
 * @property string $type
 * @property string $title
 * @property string|null $body
 * @property array<array-key, mixed>|null $data
 * @property Carbon|null $read_at
 * @property Carbon $created_at
 */
class Notification extends Model
{
    protected $table = 'notifications';

    protected $guarded = ['id'];

    public const UPDATED_AT = null;

    protected function casts(): array
    {
        return [
            'data' => 'array',
            'read_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }
}
