<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Domain\Jobs\JobRunner;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/** Worker queue (Redis) chạy một job nghiệp vụ theo id (D-60). Retry do JobRunner quản lý, không dùng retry của queue. */
final class RunJob implements ShouldQueue
{
    use Queueable;

    public int $tries = 1;

    public function __construct(public readonly int $jobId) {}

    public function handle(JobRunner $runner): void
    {
        $runner->run($this->jobId);
    }
}
