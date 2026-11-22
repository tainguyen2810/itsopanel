<?php

declare(strict_types=1);

namespace App\Models;

use App\Domain\Jobs\JobEvents;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Dòng log của job.
 *
 * @property int $id
 * @property int $job_id
 * @property int|null $step_id
 * @property string $level
 * @property string $message
 * @property Carbon $at
 */
class JobLog extends Model
{
    protected $table = 'job_logs';

    protected $guarded = ['id'];

    public $timestamps = false;

    /**
     * Mỗi dòng log phát lên Redis pub/sub `itso:job:<uuid>` (D-106, ADR 0051). Chỉ là tín hiệu: SSE đọc lại job_logs
     * (nguồn sự thật) nên tin đến trước khi transaction commit không làm sai thứ tự.
     */
    protected static function booted(): void
    {
        static::created(fn (JobLog $l) => app(JobEvents::class)->published($l));
    }

    protected function casts(): array
    {
        return [
            'at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Job, $this> */
    public function job(): BelongsTo
    {
        return $this->belongsTo(Job::class, 'job_id');
    }
}
