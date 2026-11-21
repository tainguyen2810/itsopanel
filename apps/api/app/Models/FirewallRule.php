<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Rule tường lửa nháp của máy chủ (D-76): chỉ có hiệu lực sau firewall:apply + confirm.
 *
 * @property int $id
 * @property string $uuid
 * @property int $server_id
 * @property int $priority
 * @property string $action
 * @property string $direction
 * @property string $protocol
 * @property bool $enabled
 * @property string|null $port_range
 * @property string|null $source_cidr
 * @property string|null $comment
 * @property string $managed_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class FirewallRule extends Model
{
    use HasPublicUuid;

    protected $table = 'firewall_rules';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['priority' => 'integer', 'enabled' => 'boolean'];
    }
}
