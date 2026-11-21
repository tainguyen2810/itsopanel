<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Số đo mức dùng của account (ghi bởi itso:usage-refresh từ op quota.report).
 *
 * @property int $id
 * @property int $hosting_account_id
 * @property int|null $disk_mb
 * @property int|null $inode_count
 * @property float|null $cpu_seconds
 * @property int|null $mem_peak_mb
 * @property int|null $db_size_mb
 * @property int|null $backup_size_mb
 * @property Carbon $at
 */
class AccountUsageSnapshot extends Model
{
    public $timestamps = false;

    protected $table = 'account_usage_snapshots';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['at' => 'datetime', 'cpu_seconds' => 'float'];
    }
}
