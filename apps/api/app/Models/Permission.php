<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Quyền (vd. `users.write`).
 *
 * @property int $id
 * @property string $key
 * @property string $group_key
 * @property string|null $description
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Permission extends Model
{
    protected $table = 'permissions';

    protected $guarded = ['id'];
}
