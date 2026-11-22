<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Cổng host cấp cho service compose (D-97): unique (server_id, port, protocol), dải 20000–29999.
 *
 * @property int $id
 * @property int $server_id
 * @property int $port
 * @property string $protocol
 * @property int $compose_project_id
 * @property string $service
 * @property int $container_port
 * @property Carbon $created_at
 */
class PortAllocation extends Model
{
    public const UPDATED_AT = null;

    protected $table = 'port_allocations';

    protected $guarded = ['id'];
}
