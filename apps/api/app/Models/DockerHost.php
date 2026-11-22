<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Docker trên một server (D-94, D-95). Khóa chính là server_id.
 *
 * @property int $server_id
 * @property bool $enabled
 * @property string $state not_installed|installing|enabled|degraded
 * @property string|null $engine_version
 * @property string|null $compose_version
 * @property string|null $api_version
 * @property array<string, mixed> $daemon_config
 * @property list<array<string, mixed>> $checks
 * @property int $port_range_from
 * @property int $port_range_to
 * @property Carbon|null $firewall_synced_at
 * @property Carbon|null $observed_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class DockerHost extends Model
{
    protected $table = 'docker_hosts';

    protected $primaryKey = 'server_id';

    public $incrementing = false;

    protected $guarded = [];

    protected function casts(): array
    {
        return ['enabled' => 'boolean', 'daemon_config' => 'array', 'checks' => 'array', 'firewall_synced_at' => 'datetime',
            'observed_at' => 'datetime'];
    }
}
