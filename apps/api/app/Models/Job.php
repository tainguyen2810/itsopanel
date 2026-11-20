<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasPublicUuid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * Tác vụ nền nhiều bước (D-60).
 *
 * @property int $id
 * @property string $uuid
 * @property string $type
 * @property int|null $server_id
 * @property string|null $resource_type
 * @property int|null $resource_id
 * @property int|null $requested_by_user_id
 * @property string|null $idempotency_key
 * @property string $state
 * @property int $progress
 * @property int $attempts
 * @property int $max_attempts
 * @property int $timeout_sec
 * @property string|null $error_code
 * @property string|null $error_message
 * @property int|null $parent_job_id
 * @property Carbon|null $started_at
 * @property Carbon|null $finished_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Job extends Model
{
    use HasPublicUuid;

    protected $table = 'jobs';

    protected $guarded = ['id', 'uuid'];

    protected $hidden = ['id'];

    protected function casts(): array
    {
        return [
            'progress' => 'integer',
            'started_at' => 'datetime',
            'finished_at' => 'datetime',
        ];
    }

    /** @return HasMany<JobStep, $this> */
    public function steps(): HasMany
    {
        return $this->hasMany(JobStep::class, 'job_id');
    }

    /** @return HasMany<JobLog, $this> */
    public function logs(): HasMany
    {
        return $this->hasMany(JobLog::class, 'job_id');
    }

    /** @return BelongsTo<User, $this> */
    public function requestedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'requested_by_user_id');
    }

    /** @return BelongsTo<Server, $this> */
    public function server(): BelongsTo
    {
        return $this->belongsTo(Server::class, 'server_id');
    }
}
