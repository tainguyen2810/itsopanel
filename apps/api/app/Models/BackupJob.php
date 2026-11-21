<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Một lần chạy backup vào một repo (lịch sử theo policy).
 *
 * @property int $id
 * @property int|null $policy_id
 * @property int|null $job_id
 * @property int|null $repository_id
 * @property int|null $snapshot_id
 * @property Carbon|null $started_at
 * @property Carbon|null $finished_at
 * @property string $status
 * @property int|null $bytes_added
 * @property int|null $files_new
 */
class BackupJob extends Model
{
    public $timestamps = false;

    protected $table = 'backup_jobs';

    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['started_at' => 'datetime', 'finished_at' => 'datetime'];
    }
}
