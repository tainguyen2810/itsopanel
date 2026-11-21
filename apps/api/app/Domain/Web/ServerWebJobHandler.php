<?php

declare(strict_types=1);

namespace App\Domain\Web;

use App\Domain\Jobs\JobHandler;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\PhpVersion;
use App\Models\ServerSoftware;
use Illuminate\Support\Carbon;

/**
 * Observed state cho job php.version.install/remove, php.extensions.install và setup.stack (bước 4 wizard):
 * php_versions theo bước php.*, server_software theo bước software.install.
 */
final class ServerWebJobHandler implements JobHandler
{
    public function succeeded(Job $job): void
    {
        foreach ($this->steps($job) as $step) {
            $res = is_array($step->result) ? $step->result : [];
            $p = $step->params_redacted;
            match ($step->op) {
                'php.version.install', 'php.ext.install' => $this->php($job, (string) ($p['version'] ?? ''), function (PhpVersion $r) use ($p, $res, $step): void {
                    $exts = array_values(array_unique(array_merge($r->extensions, array_map('strval', (array) ($step->op === 'php.ext.install'
                        ? ($res['installed'] ?? $p['extensions'] ?? []) : ($p['extensions'] ?? []))))));
                    sort($exts);
                    $r->fill(['status' => 'ready', 'extensions' => $exts, 'observed_version' => $r->spec_version,
                        'observed_at' => Carbon::now(), 'drift' => null,
                        'observed_facts' => array_merge($r->observed_facts, ['version' => $p['version'] ?? null])])->save();
                }),
                'php.version.remove' => $this->php($job, (string) ($p['version'] ?? ''), fn (PhpVersion $r) => $r->delete()),
                'software.install' => $this->software($job, (string) ($p['recipe'] ?? ''), function (ServerSoftware $r) use ($res): void {
                    $r->fill(['status' => 'ready', 'version' => is_string($res['version'] ?? null) ? $res['version'] : $r->version,
                        'observed_version' => $r->spec_version, 'observed_at' => Carbon::now(), 'drift' => null,
                        'observed_facts' => ['installed' => ($res['installed'] ?? true) !== false, 'changed' => (bool) ($res['changed'] ?? false)]])->save();
                }),
                default => null,
            };
        }
    }

    public function failed(Job $job): void
    {
        $msg = mb_substr((string) ($job->error_message ?? $job->state), 0, 200);
        PhpVersion::query()->where('last_job_id', $job->id)->get()->each(function (PhpVersion $r) use ($msg, $job): void {
            // Gỡ lỗi: vẫn còn cài; cài/extension lỗi: failed nếu chưa từng ready.
            $status = $job->type === 'php.version.remove' || $r->observed_version > 0 ? 'ready' : 'failed';
            $r->fill(['status' => $status, 'observed_at' => Carbon::now(), 'drift' => ['apply' => $msg]])->save();
        });
        // setup.stack: bước đã xong vẫn ghi nhận; bước lỗi/bỏ qua → failed.
        $this->succeededSteps($job);
        ServerSoftware::query()->where('last_job_id', $job->id)->where('status', 'provisioning')->get()
            ->each(fn (ServerSoftware $r) => $r->fill(['status' => 'failed', 'observed_at' => Carbon::now(), 'drift' => ['apply' => $msg]])->save());
    }

    private function succeededSteps(Job $job): void
    {
        if ($job->type !== 'setup.stack') {
            return;
        }
        foreach ($this->steps($job) as $step) {
            if ($step->state === 'succeeded' && $step->op === 'software.install') {
                $p = $step->params_redacted;
                $res = is_array($step->result) ? $step->result : [];
                $this->software($job, (string) ($p['recipe'] ?? ''), fn (ServerSoftware $r) => $r->fill(['status' => 'ready',
                    'version' => is_string($res['version'] ?? null) ? $res['version'] : $r->version, 'observed_version' => $r->spec_version,
                    'observed_at' => Carbon::now(), 'drift' => null])->save());
            }
        }
    }

    /** @return iterable<JobStep> */
    private function steps(Job $job): iterable
    {
        return JobStep::query()->where('job_id', $job->id)->orderBy('seq')->get();
    }

    private function php(Job $job, string $version, callable $fn): void
    {
        $r = PhpVersion::query()->where('server_id', $job->server_id)->where('version', $version)->where('last_job_id', $job->id)
            ->lockForUpdate()->first();
        if ($r instanceof PhpVersion) {
            $fn($r);
        }
    }

    private function software(Job $job, string $key, callable $fn): void
    {
        $r = ServerSoftware::query()->where('server_id', $job->server_id)->where('software_key', $key)->where('last_job_id', $job->id)
            ->lockForUpdate()->first();
        if ($r instanceof ServerSoftware) {
            $fn($r);
        }
    }
}
