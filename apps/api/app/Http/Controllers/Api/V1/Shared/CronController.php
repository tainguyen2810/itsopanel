<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Domain\Data\CronService;
use App\Http\Presenters\DataPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\CronJob;
use App\Models\CronRun;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** /admin|portal/cron-jobs/* (Prompt 6.3, D-74). */
final class CronController extends DataController
{
    public function __construct(Access $access, JobPresenter $jobs, private readonly CronService $service)
    {
        parent::__construct($access, $jobs);
    }

    public function index(Request $request): JsonResponse
    {
        $q = $this->scoped($request, CronJob::class);
        Listing::search($request, $q, ['cron_jobs.command', 'cron_jobs.schedule']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'cron_jobs.created_at', 'schedule' => 'cron_jobs.schedule',
            'last_run_at' => 'cron_jobs.last_run_at', 'status' => 'cron_jobs.status'], '-created_at',
            fn (CronJob $c): array => DataPresenter::cron($c)));
    }

    public function store(Request $request): JsonResponse
    {
        self::only($request, ['hosting_account_uuid', 'website_uuid', 'schedule', 'command', 'working_dir', 'php_version', 'enabled', 'timeout_sec']);
        $in = $request->validate(self::rules() + ['hosting_account_uuid' => ['required', 'uuid'], 'schedule' => ['required', 'string', 'max:100'],
            'command' => ['required', 'string', 'max:1024'], 'website_uuid' => ['sometimes', 'nullable', 'uuid'],
            'php_version' => ['sometimes', 'nullable', 'string', 'regex:/^[5-9]\.[0-9]$/']]);
        [, $job] = $this->service->create($this->actor($request), $this->account($request, $in['hosting_account_uuid']), $in);

        return $this->accepted($request, $job);
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $c = $this->find($request, CronJob::class, $id);
        $this->ifMatch($request, DataPresenter::etag($c));
        self::only($request, ['schedule', 'command', 'working_dir', 'enabled', 'timeout_sec']);
        $in = $request->validate(self::rules() + ['schedule' => ['sometimes', 'string', 'max:100'], 'command' => ['sometimes', 'string', 'max:1024']]);

        return $this->accepted($request, $this->service->update($this->actor($request), $c, $in));
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        return $this->accepted($request, $this->service->delete($this->actor($request), $this->find($request, CronJob::class, $id)));
    }

    public function run(Request $request, string $id): JsonResponse
    {
        return $this->accepted($request, $this->service->runNow($this->actor($request), $this->find($request, CronJob::class, $id)));
    }

    public function runs(Request $request, string $id): JsonResponse
    {
        $c = $this->find($request, CronJob::class, $id);
        $q = CronRun::query()->where('cron_job_id', $c->id);

        return response()->json(Listing::page($request, $q, ['started_at' => 'cron_runs.started_at'], '-started_at',
            fn (CronRun $r): array => DataPresenter::cronRun($r)));
    }

    /** @return array<string, list<string>> */
    private static function rules(): array
    {
        return ['working_dir' => ['sometimes', 'string', 'max:1024'], 'enabled' => ['sometimes', 'boolean'],
            'timeout_sec' => ['sometimes', 'integer', 'min:60', 'max:86400']];
    }
}
