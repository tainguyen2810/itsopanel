<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Dung lượng đã cấp của server (D-42). Khóa chính là server_id.
 *
 * @property int $server_id
 * @property int $cpu_cores
 * @property int $ram_mb
 * @property int $disk_mb
 * @property int $allocated_cpu_pct
 * @property int $allocated_ram_mb
 * @property int $allocated_disk_mb
 * @property int $account_count
 * @property int $max_accounts
 * @property Carbon $updated_at
 */
class ServerCapacity extends Model
{
    public $timestamps = false;

    public $incrementing = false;

    protected $table = 'server_capacity';

    protected $primaryKey = 'server_id';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['updated_at' => 'datetime'];
    }
}
