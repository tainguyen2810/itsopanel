<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\PgTextArray;
use Database\Factories\HostingPackageVersionFactory;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Phiên bản gói: bất biến (trigger), account trỏ tới phiên bản.
 *
 * @property int $id
 * @property int $package_id
 * @property int $version
 * @property int $disk_mb
 * @property int $inode_limit
 * @property int $cpu_percent
 * @property int $ram_mb
 * @property int $tasks_max
 * @property int $php_workers_max
 * @property int $io_weight
 * @property int|null $io_read_bps
 * @property int|null $io_write_bps
 * @property int $website_limit
 * @property int $alias_domain_limit
 * @property int $subdomain_limit
 * @property int $database_limit
 * @property int $db_user_limit
 * @property int $ftp_limit
 * @property int $cron_limit
 * @property int $cron_min_interval_min
 * @property int $backup_quota_mb
 * @property array<array-key, mixed> $backup_retention
 * @property bool $ssh_allowed
 * @property list<string> $php_versions
 * @property array<array-key, mixed> $php_limits
 * @property int $retention_days_after_terminate
 * @property int|null $created_by_user_id
 * @property Carbon $created_at
 */
class HostingPackageVersion extends Model
{
    /** @use HasFactory<HostingPackageVersionFactory> */
    use HasFactory;

    protected $table = 'hosting_package_versions';

    protected $guarded = ['id'];

    public const UPDATED_AT = null;

    protected function casts(): array
    {
        return [
            'php_versions' => PgTextArray::class,
            'backup_retention' => 'array',
            'php_limits' => 'array',
            'ssh_allowed' => 'boolean',
        ];
    }

    /** @return BelongsTo<HostingPackage, $this> */
    public function package(): BelongsTo
    {
        return $this->belongsTo(HostingPackage::class, 'package_id');
    }
}
