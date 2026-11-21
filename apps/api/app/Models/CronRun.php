<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Một lần chạy cron (trigger schedule từ cron.inspect, manual từ cron.run_once).
 *
 * @property int $id
 * @property string $uuid
 * @property int $cron_job_id
 * @property Carbon $started_at
 * @property Carbon|null $finished_at
 * @property int|null $exit_code
 * @property string|null $output_tail
 * @property string $status
 * @property string $trigger
 */
class CronRun extends Model
{
    use HasPublicUuid;

    protected $table = 'cron_runs';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return ['started_at' => 'datetime', 'finished_at' => 'datetime'];
    }

    /** @return BelongsTo<CronJob, $this> */
    public function job(): BelongsTo
    {
        return $this->belongsTo(CronJob::class, 'cron_job_id')->withTrashed();
    }
}
