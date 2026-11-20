<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Thông tin MFA (totp | recovery). `secret_encrypted` mã hóa bằng APP_KEY.
 *
 * @property int $id
 * @property int $user_id
 * @property string $type
 * @property string $secret_encrypted
 * @property string|null $label
 * @property Carbon|null $last_used_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class MfaCredential extends Model
{
    protected $table = 'mfa_credentials';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return [
            'last_used_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class, 'user_id');
    }
}
