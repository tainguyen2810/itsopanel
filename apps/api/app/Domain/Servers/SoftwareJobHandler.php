<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Domain\Jobs\JobHandler;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\ServerSoftware;
use Illuminate\Support\Carbon;

/** Ghi observed state của server_software khi job software.install/remove kết thúc. */
final class SoftwareJobHandler implements JobHandler
{
    public function succeeded(Job $job): void
    {
        $row = $this->row($job);
        if ($row === null) {
            return;
        }
        $res = JobStep::query()->where('job_id', $job->id)->orderByDesc('seq')->value('result');
        $res = is_array($res) ? $res : (is_string($res) ? (array) json_decode($res, true) : []);
        $installed = $job->type === 'software.install' && ($res['installed'] ?? true) !== false;
        $row->fill([
            'status' => 'ready',
            'version' => $installed ? (is_string($res['version'] ?? null) ? $res['version'] : $row->version) : null,
            'observed_version' => $row->spec_version, 'observed_at' => Carbon::now(), 'drift' => null,
            'observed_facts' => ['installed' => $installed, 'changed' => (bool) ($res['changed'] ?? false)],
        ])->save();
    }

    public function failed(Job $job): void
    {
        $row = $this->row($job);
        $row?->fill(['status' => 'failed', 'observed_at' => Carbon::now(),
            'drift' => ['apply' => mb_substr((string) ($job->error_message ?? $job->state), 0, 200)]])->save();
    }

    private function row(Job $job): ?ServerSoftware
    {
        return ServerSoftware::query()->where('last_job_id', $job->id)->lockForUpdate()->first();
    }
}
