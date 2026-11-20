<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Lần đăng nhập (khóa lũy tiến theo email + IP).
 *
 * @property int $id
 * @property string $realm
 * @property string $email
 * @property string $ip_address
 * @property bool $success
 * @property Carbon $at
 */
class LoginAttempt extends Model
{
    protected $table = 'login_attempts';

    protected $guarded = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'success' => 'boolean',
            'at' => 'datetime',
        ];
    }
}
