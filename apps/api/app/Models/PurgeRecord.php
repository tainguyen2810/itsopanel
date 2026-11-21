<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Biên bản purge account (D-46): lên lịch → backup cuối + kiểm chứng → xác nhận.
 *
 * @property int $id
 * @property string $uuid
 * @property int $hosting_account_id
 * @property int $requested_by_user_id
 * @property int|null $confirmed_by_user_id
 * @property int|null $final_backup_snapshot_id
 * @property Carbon|null $backup_verified_at
 * @property list<array<string, mixed>> $objects
 * @property Carbon $scheduled_for
 * @property Carbon|null $completed_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class PurgeRecord extends Model
{
    use HasPublicUuid;

    protected $table = 'purge_records';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['objects' => 'array', 'backup_verified_at' => 'datetime', 'scheduled_for' => 'datetime', 'completed_at' => 'datetime'];
    }
}
