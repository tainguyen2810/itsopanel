<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * IP/CIDR được phép vào realm admin hoặc API.
 *
 * @property int $id
 * @property string $cidr
 * @property string $scope
 * @property string|null $note
 * @property int|null $created_by_user_id
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class IpAllowlistEntry extends Model
{
    protected $table = 'ip_allowlist';

    protected $guarded = ['id'];
}
