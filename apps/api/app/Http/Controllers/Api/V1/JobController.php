<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobEvents;
use App\Domain\Jobs\JobRunner;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\Job;
use App\Models\JobLog;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * /admin/jobs và /portal/jobs (cùng controller, phạm vi theo App\Auth\Access::jobs). Tiến độ: polling
 * GET /jobs/{id} hoặc /jobs/{id}/events (SSE thật từ Phase 11, ADR 0051).
 */
final class JobController
{
    public function __construct(
        private readonly Access $access,
        private readonly JobPresenter $present,
        private readonly JobRunner $runner,
        private readonly AuditLogger $audit,
        private readonly JobEvents $events,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $request->validate(['filter.state' => ['sometimes', 'in:queued,running,succeeded,failed,cancel_requested,cancelled,timed_out,waiting_agent']]);
        $q = $this->access->jobs($this->user($request));
        $state = $request->input('filter.state');
        if (is_string($state)) {
            $q->where('state', $state);
        }
        Listing::search($request, $q, ['jobs.type']);
        $realm = Realm::of($request);

        return response()->json(Listing::page($request, $q,
            ['created_at' => 'jobs.created_at', 'state' => 'jobs.state', 'type' => 'jobs.type'],
            '-created_at', fn (Job $j): array => $this->present->job($j, $realm), fn (array $page) => $this->present->prefetch($page)));
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $job = $this->find($request, $id);

        return response()->json(['data' => $this->present->job($job, Realm::of($request))])
            ->header('ETag', '"'.sha1($job->state.$job->progress.$job->updated_at->format('U.u')).'"');
    }

    /**
     * SSE thật (D-106, ADR 0051): snapshot job, rồi log mới (`id` = seq) và snapshot khi trạng thái đổi; heartbeat 15 giây;
     * tối đa 5 phút hoặc tới khi job kết thúc; `Last-Event-ID` bỏ các sự kiện đã nhận. Quyền như GET /jobs/{id}.
     */
    public function events(Request $request, string $id): StreamedResponse
    {
        $job = $this->find($request, $id);
        $realm = Realm::of($request);
        $last = $request->header('Last-Event-ID');
        $after = is_string($last) && preg_match('/^[0-9]{1,18}$/', $last) === 1 ? (int) $last : 0;
        $maxSec = (float) config('itso.sse.max_sec', 300);
        $beatSec = (float) config('itso.sse.heartbeat_sec', 15);
        $pollUs = (int) config('itso.sse.poll_ms', 1000) * 1000;

        return response()->stream(function () use ($job, $realm, $after, $maxSec, $beatSec, $pollUs): void {
            $start = microtime(true);
            $beat = $start;
            echo "retry: 2000\n\n";
            $snap = $job->state.'|'.$job->progress.'|'.$job->attempts.'|'.($job->error_code ?? '');
            echo JobEvents::frame('job', $after, $this->present->job($job, $realm));
            while (true) {
                [$out, $after, $snap, $done] = $this->events->frames($job, $realm, $after, $snap, $this->present);
                if ($out !== '') {
                    echo $out;
                    $beat = microtime(true);
                } elseif (microtime(true) - $beat >= $beatSec) {
                    echo ": ping\n\n";
                    $beat = microtime(true);
                }
                if (ob_get_level() > 0) {
                    ob_flush();
                }
                flush();
                if ($done || microtime(true) - $start >= $maxSec || connection_aborted() === 1) {
                    break;
                }
                usleep($pollUs);
            }
        }, 200, [
            'Content-Type' => 'text/event-stream; charset=utf-8',
            'Cache-Control' => 'no-cache, no-transform',
            'X-Accel-Buffering' => 'no',
        ]);
    }

    public function logs(Request $request, string $id): JsonResponse
    {
        $job = $this->find($request, $id);
        $q = JobLog::query()->where('job_id', $job->id);
        Listing::search($request, $q, ['job_logs.message']);

        return response()->json(Listing::page($request, $q, ['seq' => 'job_logs.id', 'at' => 'job_logs.at'], 'seq',
            fn (JobLog $l): array => JobPresenter::log($l)));
    }

    public function cancel(Request $request, string $id): JsonResponse
    {
        $job = $this->find($request, $id);
        if (! in_array($job->state, ['queued', 'running'], true)) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Không hủy được', "Job đang ở trạng thái {$job->state}.");
        }
        $job = $this->runner->cancel($job);
        $this->audit->record('job.cancel', $job, ['state' => $job->state], 'success', $job->server_id, $job->id);

        return response()->json(['data' => $this->present->job($job, Realm::of($request))]);
    }

    public function retry(Request $request, string $id): JsonResponse
    {
        $job = $this->find($request, $id);
        if (! in_array($job->state, ['failed', 'cancelled', 'timed_out'], true)) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Không chạy lại được', "Job đang ở trạng thái {$job->state}.");
        }
        $job = $this->runner->retry($job);
        $this->audit->record('job.retry', $job, null, 'success', $job->server_id, $job->id);
        $job->refresh();
        $data = $this->present->job($job, Realm::of($request));

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function user(Request $request): User
    {
        $u = $request->user();
        if (! $u instanceof User) {
            throw ApiProblem::unauthenticated();
        }

        return $u;
    }

    private function find(Request $request, string $id): Job
    {
        $job = Str::isUuid($id) ? $this->access->jobs($this->user($request))->where('jobs.uuid', $id)->first() : null;
        if (! $job instanceof Job) {
            throw new NotFoundHttpException;
        }

        return $job;
    }
}
