<?php

declare(strict_types=1);

namespace App\Models;

use App\Casts\PgTextArray;
use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Yêu cầu khôi phục (D-85).
 *
 * @property int $id
 * @property string $uuid
 * @property int|null $snapshot_id
 * @property int|null $hosting_account_id
 * @property string $target_type hosting_account
 * @property int|null $target_id
 * @property int|null $target_server_id
 * @property string $mode new|overwrite
 * @property list<string> $items
 * @property int|null $job_id
 * @property string $status
 * @property array<string, mixed>|null $result
 * @property string|null $error
 * @property int|null $pre_restore_snapshot_id
 * @property int $requested_by_user_id
 * @property Carbon|null $finished_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read BackupSnapshot $snapshot
 */
class RestoreJob extends Model
{
    use HasPublicUuid;

    protected $table = 'restore_jobs';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['items' => PgTextArray::class, 'result' => 'array', 'finished_at' => 'datetime'];
    }

    /** @return BelongsTo<BackupSnapshot, $this> */
    public function snapshot(): BelongsTo
    {
        return $this->belongsTo(BackupSnapshot::class, 'snapshot_id');
    }
}
