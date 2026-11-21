<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\PgTextArray;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Snapshot restic panel đã ghi nhận (kết quả backup.run).
 *
 * @property int $id
 * @property string $uuid
 * @property int $destination_id
 * @property int $repository_id
 * @property string $restic_snapshot_id
 * @property string $scope_type hosting_account|website|database|server_config|panel
 * @property int|null $scope_id
 * @property int|null $hosting_account_id
 * @property int|null $website_id
 * @property list<string> $databases
 * @property list<string> $contents
 * @property list<string> $tags
 * @property int|null $size_bytes
 * @property string|null $panel_version
 * @property array<string, mixed>|null $meta
 * @property Carbon|null $locked_until
 * @property int|null $job_id
 * @property Carbon $taken_at
 * @property Carbon|null $verified_at
 * @property-read BackupRepository $repository
 * @property-read BackupDestination $destination
 * @property-read HostingAccount|null $account
 */
class BackupSnapshot extends Model
{
    use HasPublicUuid;

    public $timestamps = false;

    protected $table = 'backup_snapshots';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['databases' => PgTextArray::class, 'contents' => PgTextArray::class, 'tags' => PgTextArray::class, 'meta' => 'array',
            'locked_until' => 'datetime', 'taken_at' => 'datetime', 'verified_at' => 'datetime', 'size_bytes' => 'integer'];
    }

    /** @return BelongsTo<BackupRepository, $this> */
    public function repository(): BelongsTo
    {
        return $this->belongsTo(BackupRepository::class, 'repository_id')->withTrashed();
    }

    /** @return BelongsTo<BackupDestination, $this> */
    public function destination(): BelongsTo
    {
        return $this->belongsTo(BackupDestination::class, 'destination_id')->withTrashed();
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
