<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\Bytea;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Carbon;

/**
 * Repo restic = đích × server × account | đích × server (D-82, ADR 0029). Mật khẩu chỉ đi qua tham chiếu bí mật.
 *
 * @property int $id
 * @property string $uuid
 * @property int $destination_id
 * @property int $server_id
 * @property string $scope_type hosting_account|server
 * @property int|null $hosting_account_id
 * @property string $path
 * @property string $password_encrypted
 * @property Carbon|null $initialized_at
 * @property int $size_bytes
 * @property int $snapshots_count
 * @property Carbon|null $last_snapshot_at
 * @property Carbon|null $last_check_at
 * @property bool|null $last_check_ok
 * @property string $quota_state ok|warn|paused
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read BackupDestination $destination
 * @property-read Server $server
 * @property-read HostingAccount|null $account
 */
class BackupRepository extends Model
{
    use HasPublicUuid, SoftDeletes;

    protected $table = 'backup_repositories';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id', 'password_encrypted'];

    protected function casts(): array
    {
        return ['password_encrypted' => Bytea::class, 'initialized_at' => 'datetime', 'last_snapshot_at' => 'datetime',
            'last_check_at' => 'datetime', 'last_check_ok' => 'boolean', 'size_bytes' => 'integer', 'snapshots_count' => 'integer'];
    }

    /** @return BelongsTo<BackupDestination, $this> */
    public function destination(): BelongsTo
    {
        return $this->belongsTo(BackupDestination::class, 'destination_id')->withTrashed();
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class, 'server_id');
    }

    /** @return BelongsTo<HostingAccount, $this> */
    public function account(): BelongsTo
    {
        return $this->belongsTo(HostingAccount::class, 'hosting_account_id')->withTrashed();
    }
}
