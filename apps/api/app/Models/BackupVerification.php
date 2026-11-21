<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Lần kiểm chứng (restic check / restore test, D-87).
 *
 * @property int $id
 * @property string $uuid
 * @property int $destination_id
 * @property int|null $repository_id
 * @property int|null $hosting_account_id
 * @property int|null $snapshot_id
 * @property string $kind check|restore_test
 * @property string $state running|succeeded|failed
 * @property int|null $read_data_percent
 * @property int|null $files_checked
 * @property int $mismatches
 * @property string|null $error
 * @property int|null $job_id
 * @property Carbon $started_at
 * @property Carbon|null $finished_at
 */
class BackupVerification extends Model
{
    use HasPublicUuid;

    public $timestamps = false;

    protected $table = 'backup_verifications';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return ['started_at' => 'datetime', 'finished_at' => 'datetime'];
    }
}
