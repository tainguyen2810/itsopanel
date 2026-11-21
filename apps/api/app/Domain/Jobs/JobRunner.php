<?php

declare(strict_types=1);

namespace App\Domain\Jobs;

use App\Domain\Audit\AuditLogger;
use App\Domain\Notifications\Notifier;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentResult;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Jobs\RunJob;
use App\Models\Job;
use App\Models\JobLog;
use App\Models\JobStep;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Chạy job nhiều bước (D-60): mỗi bước một op agent có kiểu, op_id = job_uuid:seq:attempt (agent cache theo op_id
 * nên gửi lại không chạy hai lần). Lỗi tạm thời (retryable / agent không kết nối) → xếp hàng lại có backoff tới
 * max_attempts; lỗi khác → failed. Hủy: queued → cancelled ngay; running → cancel_requested, dừng trước bước kế.
 * Quá timeout_sec tính từ lúc bắt đầu → timed_out.
 */
final class JobRunner
{
    public const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out'];

    public function __construct(private readonly AgentClient $agent, private readonly Notifier $notifier,
        private readonly Secrets $secrets) {}

    public function run(int $jobId): void
    {
        $job = DB::transaction(function () use ($jobId): ?Job {
            /** @var Job|null $job */
            $job = Job::query()->lockForUpdate()->find($jobId);
            if ($job === null || in_array($job->state, self::TERMINAL, true) || $job->state === 'running') {
                return null;
            }
            if ($job->state === 'cancel_requested') {
                $this->finish($job, 'cancelled', null, null, null);

                return null;
            }
            $job->state = 'running';
            $job->attempts++;
            $job->started_at ??= Carbon::now();
            $job->save();
            $this->log($job, 'info', "Bắt đầu lần chạy {$job->attempts}/{$job->max_attempts}.");

            return $job;
        });
        if ($job === null) {
            return;
        }

        $steps = JobStep::query()->where('job_id', $job->id)->orderBy('seq')->get();
        $total = max(1, $steps->count());
        $done = $steps->where('state', 'succeeded')->count();
        $requestedBy = $this->requestedBy($job);

        foreach ($steps as $step) {
            if ($step->state === 'succeeded') {
                continue;
            }
            $job->refresh();
            if ($job->state === 'cancel_requested') {
                $this->finish($job, 'cancelled', null, null, null);

                return;
            }
            $remaining = $job->timeout_sec - (int) $job->started_at?->diffInSeconds(Carbon::now());
            if ($remaining <= 0) {
                $this->finish($job, 'timed_out', 'deadline_exceeded', 'Job vượt quá thời gian cho phép.', $step->seq);

                return;
            }
            $step->state = 'running';
            $step->attempts++;
            $step->op_id = $job->uuid.':'.$step->seq.':'.$job->attempts;
            $step->started_at = Carbon::now();
            $step->save();
            $this->log($job, 'info', "Bước {$step->seq}: {$step->op}", $step);

            $panel = $this->panelStep($step->op);
            try {
                if ($panel !== null) {
                    $res = new AgentResult($step->op_id, true, $panel->run($step->params_redacted, $job), null, 0, 'panel');
                } else {
                    // Bí mật chỉ được thay vào bản gửi đi; params_redacted giữ nguyên tham chiếu.
                    $params = $this->secrets->resolve($step->params_redacted);
                    $res = $this->agent->call($step->op, $params, $step->op_id, $requestedBy, (float) min($remaining, 300));
                }
            } catch (AgentUnavailable $e) {
                $this->stepFailed($job, $step, 'agent_unavailable', mb_substr($e->getMessage(), 0, 300), true);

                return;
            } catch (PanelStepFailed $e) {
                $this->stepFailed($job, $step, $e->errorCode, mb_substr($e->getMessage(), 0, 300), $e->retryable);

                return;
            }
            if (! $res->ok) {
                $err = $res->error ?? ['code' => 'internal', 'message' => 'Lỗi không rõ', 'retryable' => false];
                $this->stepFailed($job, $step, $err['code'], $err['message'], $err['retryable'] || $err['code'] === 'deadline_exceeded');

                return;
            }
            $step->state = 'succeeded';
            $step->result = $res->data !== null ? AuditLogger::redact($res->data) : null;
            $step->finished_at = Carbon::now();
            $step->save();
            $done++;
            Job::query()->whereKey($job->id)->update(['progress' => (int) floor($done * 100 / $total)]);
            $this->log($job, 'info', "Bước {$step->seq} xong".($res->cached ? ' (agent trả kết quả đã lưu)' : '').'.', $step);
        }
        $job->refresh();
        $this->finish($job, 'succeeded', null, null, null);
    }

    /** Hủy theo yêu cầu người dùng. Trả về job đã cập nhật. */
    public function cancel(Job $job): Job
    {
        return DB::transaction(function () use ($job): Job {
            /** @var Job $j */
            $j = Job::query()->lockForUpdate()->findOrFail($job->id);
            if ($j->state === 'queued') {
                $this->finish($j, 'cancelled', null, null, null);
            } elseif ($j->state === 'running') {
                $j->state = 'cancel_requested';
                $j->save();
                $this->log($j, 'warn', 'Yêu cầu hủy: dừng trước bước tiếp theo.');
            }

            return $j->refresh();
        });
    }

    /** Chạy lại job đã failed/cancelled/timed_out từ bước chưa xong (bước đã xong giữ nguyên). */
    public function retry(Job $job): Job
    {
        DB::transaction(function () use ($job): void {
            JobStep::query()->where('job_id', $job->id)->whereIn('state', ['failed', 'cancelled', 'running', 'skipped'])
                ->update(['state' => 'pending', 'finished_at' => null]);
            Job::query()->whereKey($job->id)->update(['state' => 'queued', 'attempts' => 0, 'error_code' => null,
                'error_message' => null, 'finished_at' => null, 'started_at' => null]);
            $this->log($job, 'info', 'Chạy lại theo yêu cầu.');
        });
        RunJob::dispatch($job->id)->afterCommit();

        return $job->refresh();
    }

    private function stepFailed(Job $job, JobStep $step, string $code, string $message, bool $retryable): void
    {
        $step->state = 'failed';
        $step->finished_at = Carbon::now();
        $step->result = ['error' => ['code' => $code, 'message' => $message]];
        $step->save();
        $this->log($job, 'error', "Bước {$step->seq} lỗi [$code]: $message", $step);
        $job->refresh();
        if ($retryable && $job->attempts < $job->max_attempts && $job->state === 'running') {
            $delay = min(300, 5 * (2 ** ($job->attempts - 1)));
            $step->state = 'pending';
            $step->save();
            $job->state = 'queued';
            $job->error_code = $code;
            $job->error_message = $message;
            $job->save();
            $this->log($job, 'warn', "Lỗi tạm thời, thử lại sau {$delay} giây.");
            RunJob::dispatch($job->id)->delay(now()->addSeconds($delay));

            return;
        }
        $this->finish($job, 'failed', $code, $message, $step->seq);
    }

    private function finish(Job $job, string $state, ?string $code, ?string $message, ?int $stepSeq): void
    {
        DB::transaction(function () use ($job, $state, $code, $message, $stepSeq): void {
            if ($state !== 'succeeded') {
                JobStep::query()->where('job_id', $job->id)->whereIn('state', ['pending', 'running'])
                    ->update(['state' => $state === 'cancelled' ? 'cancelled' : 'skipped', 'finished_at' => Carbon::now()]);
            }
            $job->state = $state;
            $job->finished_at = Carbon::now();
            if ($state === 'succeeded') {
                $job->progress = 100;
                $job->error_code = null;
                $job->error_message = null;
            } else {
                $job->error_code = $code ?? ($state === 'cancelled' ? 'cancelled' : $job->error_code);
                $job->error_message = $message ?? ($state === 'cancelled' ? 'Đã hủy theo yêu cầu.' : $job->error_message);
            }
            $job->save();
            $this->log($job, $state === 'succeeded' ? 'info' : ($state === 'cancelled' ? 'warn' : 'error'),
                match ($state) {
                    'succeeded' => 'Hoàn tất.',
                    'cancelled' => 'Đã hủy.',
                    'timed_out' => 'Hết thời gian.',
                    default => 'Thất bại'.($stepSeq !== null ? " ở bước $stepSeq" : '').'.',
                });
            $handler = $this->handler($job);
            if ($handler !== null) {
                $state === 'succeeded' ? $handler->succeeded($job) : $handler->failed($job);
            }
        });
        if (in_array($state, ['failed', 'timed_out'], true) && $job->requested_by_user_id !== null) {
            $user = User::query()->find($job->requested_by_user_id);
            if ($user instanceof User) {
                $this->notifier->notify($user, 'job.failed', 'Tác vụ thất bại: '.$job->type,
                    (string) ($job->error_message ?? ''), 'high', '/jobs/'.$job->uuid);
            }
        }
    }

    private function panelStep(string $op): ?PanelStep
    {
        $class = ((array) config('itso.panel_steps', []))[$op] ?? null;
        $h = is_string($class) ? app($class) : null;

        return $h instanceof PanelStep ? $h : null;
    }

    private function handler(Job $job): ?JobHandler
    {
        $map = (array) config('itso.job_handlers', []);
        $class = $map[$job->type] ?? null;
        if (! is_string($class)) {
            return null;
        }
        $h = app($class);

        return $h instanceof JobHandler ? $h : null;
    }

    /** @return array{user_uuid: string|null, role: string} */
    private function requestedBy(Job $job): array
    {
        $u = $job->requested_by_user_id !== null ? User::query()->find($job->requested_by_user_id) : null;

        return $u instanceof User
            ? ['user_uuid' => $u->uuid, 'role' => $u->roleKey() ?? 'SYSTEM']
            : ['user_uuid' => null, 'role' => 'SYSTEM'];
    }

    private function log(Job $job, string $level, string $message, ?JobStep $step = null): void
    {
        JobLog::query()->create(['job_id' => $job->id, 'step_id' => $step?->id, 'level' => $level,
            'message' => mb_substr($message, 0, 2000), 'at' => Carbon::now()]);
    }
}
