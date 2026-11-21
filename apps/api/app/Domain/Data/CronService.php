<?php

declare(strict_types=1);

namespace App\Domain\Data;

use App\Domain\Hosting\QuotaService;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\CronJob;
use App\Models\CronRun;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\User;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;

/**
 * Cron (Prompt 6.3, D-74): cron_limit + cron_min_interval_min theo gói; mỗi thay đổi tạo job `cron.apply` với toàn bộ
 * desired state của account; "Chạy ngay" = cron.run_once (ghi cron_runs trigger manual); `itso:cron-sync` đọc
 * cron.inspect để ghi lần chạy theo lịch.
 */
final class CronService
{
    public function __construct(private readonly DataJobs $jobs, private readonly QuotaService $quota, private readonly AgentClient $agent) {}

    /**
     * @param  array<string, mixed>  $in  CronJobCreate
     * @return array{0: CronJob, 1: Job}
     */
    public function create(User $actor, HostingAccount $a, array $in): array
    {
        $fields = $this->validated($a, $in, null);
        [$c, $job] = $this->jobs->run($actor, $a, 'cron_job.create', function (HostingAccount $acc) use ($fields): array {
            $this->quota->ensureCanAdd($acc, 'cron_jobs');
            $c = CronJob::query()->create($fields + ['hosting_account_id' => $acc->id, 'status' => 'provisioning']);
            $spec = DataJobs::spec('cron_job.create', $c, $acc)
                ->step('cron.apply', ['account' => DataSpec::acct($acc), 'entries' => DataSpec::cronEntries($acc)]);

            return [$c, $spec, array_intersect_key($fields, array_flip(['schedule', 'command', 'working_dir', 'enabled', 'timeout_sec']))];
        });

        /** @var CronJob $c */
        return [$c, $job];
    }

    /** @param  array<string, mixed>  $in  CronJobUpdate */
    public function update(User $actor, CronJob $c, array $in): Job
    {
        $this->editable($c);
        $fields = $this->validated($c->account, $in, $c);
        [, $job] = $this->jobs->run($actor, $c->account, 'cron_job.update', function (HostingAccount $acc) use ($c, $fields): array {
            $changes = [];
            foreach ($fields as $k => $v) {
                if ($c->getAttribute($k) !== $v) {
                    $changes[$k] = ['from' => $c->getAttribute($k), 'to' => $v];
                    $c->setAttribute($k, $v);
                }
            }
            if ($changes === []) {
                throw new ApiProblem(409, 'conflict', 'Không có thay đổi', 'Cron gửi lên giống cấu hình hiện tại.');
            }
            $c->spec_version++;
            $c->status = 'provisioning';
            $c->save();
            $spec = DataJobs::spec('cron_job.update', $c, $acc)
                ->step('cron.apply', ['account' => DataSpec::acct($acc), 'entries' => DataSpec::cronEntries($acc)]);

            return [$c, $spec, $changes];
        });

        return $job;
    }

    public function delete(User $actor, CronJob $c): Job
    {
        DataJobs::ensureIdle($c);
        [, $job] = $this->jobs->run($actor, $c->account, 'cron_job.delete', function (HostingAccount $acc) use ($c): array {
            $c->status = 'deleting';
            $c->save();
            $spec = DataJobs::spec('cron_job.delete', $c, $acc)
                ->step('cron.apply', ['account' => DataSpec::acct($acc), 'entries' => DataSpec::cronEntries($acc)]);

            return [$c, $spec, ['schedule' => $c->schedule]];
        }, false);

        return $job;
    }

    /** "Chạy ngay": cron.run_once dưới uid account trong slice (tối đa 900 giây). */
    public function runNow(User $actor, CronJob $c): Job
    {
        $this->editable($c);
        [, $job] = $this->jobs->run($actor, $c->account, 'cron_job.run', function (HostingAccount $acc) use ($c): array {
            $spec = DataJobs::spec('cron_job.run', $c, $acc, 960)
                ->step('cron.run_once', ['account' => DataSpec::acct($acc), 'uuid' => $c->uuid, 'command' => $c->command,
                    'working_dir' => $c->working_dir, 'timeout_sec' => min(900, $c->timeout_sec)]);
            $spec->maxAttempts = 1;

            return [$c, $spec, ['trigger' => 'manual']];
        });

        return $job;
    }

    /**
     * Đồng bộ lần chạy theo lịch từ agent (cron.inspect) cho một account. Trả số lần chạy mới ghi nhận.
     */
    public function sync(HostingAccount $a): int
    {
        $jobs = CronJob::query()->where('hosting_account_id', $a->id)->whereNot('status', 'deleting')->get()->keyBy('uuid');
        if ($jobs->isEmpty()) {
            return 0;
        }
        try {
            $res = $this->agent->forServer($a->server_id)->call('cron.inspect', ['account' => DataSpec::acct($a), 'uuids' => $jobs->keys()->values()->all()],
                (string) Str::uuid7().':1:1', null, 20.0);
        } catch (AgentUnavailable) {
            return 0;
        }
        if (! $res->ok) {
            return 0;
        }
        $added = 0;
        foreach ((array) ($res->data['jobs'] ?? []) as $r) {
            $c = $jobs->get((string) ($r['uuid'] ?? ''));
            if (! $c instanceof CronJob || ! is_string($r['last_started_at'] ?? null)) {
                continue;
            }
            $started = Carbon::parse($r['last_started_at']);
            if (CronRun::query()->where('cron_job_id', $c->id)->where('trigger', 'schedule')->where('started_at', $started)->exists()) {
                continue;
            }
            $status = match ($r['result'] ?? '') {
                'success' => 'succeeded',
                'timeout' => 'timed_out',
                default => is_string($r['last_finished_at'] ?? null) ? 'failed' : 'running',
            };
            CronRun::query()->create(['cron_job_id' => $c->id, 'started_at' => $started,
                'finished_at' => is_string($r['last_finished_at'] ?? null) ? Carbon::parse($r['last_finished_at']) : null,
                'exit_code' => is_int($r['exit_code'] ?? null) ? $r['exit_code'] : null, 'status' => $status, 'trigger' => 'schedule',
                'output_tail' => '']);
            if ($status !== 'running') {
                $c->last_run_at = $started;
                $c->last_status = $status;
                $c->save();
            }
            $added++;
        }

        return $added;
    }

    /**
     * @param  array<string, mixed>  $in
     * @return array<string, mixed> cột cron_jobs đã kiểm
     */
    private function validated(HostingAccount $a, array $in, ?CronJob $current): array
    {
        $out = [];
        $schedule = $in['schedule'] ?? $current?->schedule;
        if (isset($in['schedule']) || $current === null) {
            $s = CronSchedule::parse((string) $schedule);
            $min = (int) ($this->quota->limits($a)['cron_min_interval_min'] ?? 1);
            if ($s->minIntervalMinutes() < $min) {
                throw ApiProblem::field('schedule', "Gói cho phép chạy cách nhau tối thiểu $min phút (lịch này: {$s->minIntervalMinutes()} phút).");
            }
            $out['schedule'] = (string) $schedule;
        }
        if (array_key_exists('command', $in) || $current === null) {
            $cmd = (string) ($in['command'] ?? '');
            if ($cmd === '' || strlen($cmd) > 1024 || preg_match('/[\r\n\x00]/', $cmd) === 1) {
                throw ApiProblem::field('command', 'Lệnh là một dòng, 1–1024 byte.');
            }
            $out['command'] = $cmd;
        }
        if (array_key_exists('working_dir', $in) || $current === null) {
            $out['working_dir'] = DataSpec::relPath($in['working_dir'] ?? '.', 'working_dir');
        }
        if (array_key_exists('enabled', $in) || $current === null) {
            $out['enabled'] = (bool) ($in['enabled'] ?? true);
        }
        if (array_key_exists('timeout_sec', $in) || $current === null) {
            $out['timeout_sec'] = (int) ($in['timeout_sec'] ?? 3600);
        }
        if ($current === null) {
            $out['php_version'] = isset($in['php_version']) ? (string) $in['php_version'] : null;
            $out['website_id'] = null;
            if (isset($in['website_uuid'])) {
                $w = Website::query()->where('hosting_account_id', $a->id)->where('uuid', (string) $in['website_uuid'])->first();
                if (! $w instanceof Website) {
                    throw ApiProblem::field('website_uuid', 'Website không thuộc account.');
                }
                $out['website_id'] = $w->id;
            }
        }

        return $out;
    }

    private function editable(CronJob $c): void
    {
        if (in_array($c->status, ['deleting', 'pending'], true)) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Cron đang bị xóa', 'Không sửa được cron đang xóa.');
        }
        DataJobs::ensureIdle($c);
    }
}
