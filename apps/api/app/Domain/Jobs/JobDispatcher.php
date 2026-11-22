<?php

declare(strict_types=1);

namespace App\Domain\Jobs;

use App\Domain\Audit\AuditLogger;
use App\Jobs\RunJob;
use App\Models\Job;
use App\Models\JobLog;
use App\Models\JobStep;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/** Tạo job + các bước (trạng thái queued) rồi đẩy vào queue Redis (D-60). */
final class JobDispatcher
{
    public function __construct(private readonly AuditLogger $audit) {}

    public static function resourceType(?Model $m): ?string
    {
        return match (true) {
            $m === null => null,
            $m->getTable() === 'registries' => 'registry',
            default => rtrim($m->getTable(), 's'),
        };
    }

    public function dispatch(JobSpec $spec, ?User $requestedBy, ?string $idempotencyKey = null): Job
    {
        if ($spec->steps === []) {
            throw new \InvalidArgumentException('Job phải có ít nhất một bước.');
        }
        $job = DB::transaction(function () use ($spec, $requestedBy, $idempotencyKey): Job {
            $job = Job::query()->create([
                'type' => $spec->type,
                'server_id' => $spec->serverId,
                'resource_type' => self::resourceType($spec->resource),
                'resource_id' => $spec->resource?->getKey(),
                'requested_by_user_id' => $requestedBy?->id,
                'idempotency_key' => $idempotencyKey,
                'state' => 'queued',
                'max_attempts' => $spec->maxAttempts,
                'timeout_sec' => $spec->timeoutSec,
            ]);
            foreach ($spec->steps as $i => $s) {
                JobStep::query()->create([
                    'job_id' => $job->id, 'seq' => $i + 1, 'op' => $s['op'],
                    'op_id' => $job->uuid.':'.($i + 1).':0',
                    'params_redacted' => AuditLogger::redact($s['params']),
                    'compensation_op' => $s['compensation_op'] ?? null,
                ]);
            }
            JobLog::query()->create(['job_id' => $job->id, 'level' => 'info',
                'message' => 'Đã xếp hàng: '.count($spec->steps).' bước.', 'at' => Carbon::now()]);

            return $job;
        });
        $this->audit->record('job.create', $job, ['type' => $job->type], 'success', $spec->serverId, $job->id, $requestedBy);
        RunJob::dispatch($job->id)->afterCommit();

        return $job;
    }
}
