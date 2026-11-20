<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Token nội bộ (automation/CLI), chỉ lưu SHA-256.
 *
 * @property int $id
 * @property int $user_id
 * @property string $name
 * @property string $token_hash
 * @property array<array-key, mixed> $scopes
 * @property string|null $allowed_cidrs
 * @property Carbon|null $expires_at
 * @property Carbon|null $last_used_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class ApiToken extends Model
{
    protected $table = 'api_tokens';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return [
            'scopes' => 'array',
            'expires_at' => 'datetime',
            'last_used_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }
}
