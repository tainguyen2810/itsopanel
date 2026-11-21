<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Trạng thái dịch vụ systemd quan sát được (op service.status, ghi bởi itso:metrics-collect).
 *
 * @property int $id
 * @property int $server_id
 * @property string $name
 * @property string|null $observed_state active|inactive
 * @property bool|null $enabled
 * @property Carbon|null $observed_at
 */
class ServerService extends Model
{
    public $timestamps = false;

    protected $table = 'server_services';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['enabled' => 'boolean', 'observed_at' => 'datetime'];
    }
}
