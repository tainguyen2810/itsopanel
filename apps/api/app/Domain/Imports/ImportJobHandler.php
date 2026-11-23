<?php

declare(strict_types=1);

namespace App\Domain\Imports;

use App\Domain\Jobs\JobHandler;
use App\Models\Job;
use App\Models\PanelImport;

/** Chốt trạng thái lượt import khi job import.* kết thúc (ImportService). */
final class ImportJobHandler implements JobHandler
{
    public function __construct(private readonly ImportService $svc) {}

    public function succeeded(Job $job): void
    {
        $this->finish($job, true);
    }

    public function failed(Job $job): void
    {
        $this->finish($job, false);
    }

    private function finish(Job $job, bool $ok): void
    {
        $imp = $job->resource_type === 'import' && $job->resource_id !== null
            ? PanelImport::query()->lockForUpdate()->find($job->resource_id) : null;
        if (! $imp instanceof PanelImport) {
            return;
        }
        match ($job->type) {
            'import.scan' => $ok ? $this->svc->scanned($imp, $job) : $imp->forceFill(['state' => 'scan_failed', 'scanned_at' => now(),
                'error' => mb_substr(trim(($job->error_code ? "[{$job->error_code}] " : '').(string) ($job->error_message ?? $job->state)), 0, 1000)])->save(),
            'import.run' => $this->svc->runFinished($imp, $job, $ok),
            'import.cutover' => $this->svc->cutoverFinished($imp, $job, $ok),
            'import.rollback' => $this->svc->rollbackFinished($imp, $job, $ok),
            default => null,
        };
    }
}
