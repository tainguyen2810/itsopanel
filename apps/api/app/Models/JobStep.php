<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Một bước của job = một op agent có kiểu.
 *
 * @property int $id
 * @property int $job_id
 * @property int $seq
 * @property string $op
 * @property string $op_id
 * @property array<array-key, mixed> $params_redacted
 * @property string $state
 * @property int $attempts
 * @property array<array-key, mixed>|null $result
 * @property string|null $compensation_op
 * @property Carbon|null $started_at
 * @property Carbon|null $finished_at
 */
class JobStep extends Model
{
    protected $table = 'job_steps';

    protected $guarded = ['id'];

    public $timestamps = false;

    protected function casts(): array
    {
        return [
            'params_redacted' => 'array',
            'result' => 'array',
            'started_at' => 'datetime',
            'finished_at' => 'datetime',
        ];
    }

    /** @return BelongsTo<Job, $this> */
    public function job(): BelongsTo
    {
        return $this->belongsTo(Job::class, 'job_id');
    }
}
