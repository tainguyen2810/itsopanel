<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Phạm vi giao cho ADMIN: `server` hoặc `hosting_account` (scope_id = id nội bộ).
 *
 * @property int $id
 * @property int $user_id
 * @property string $scope_type
 * @property int $scope_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class UserScope extends Model
{
    protected $table = 'user_scopes';

    protected $guarded = ['id'];

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }
}
