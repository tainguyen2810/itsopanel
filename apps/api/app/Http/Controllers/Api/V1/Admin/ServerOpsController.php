<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Servers\MetricsCollector;
use App\Domain\Servers\MetricsQuery;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\Server;
use App\Models\ServerService;
use App\Models\ServerSoftware;
use App\Models\SoftwareCatalog;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Prompt 4.5: dịch vụ, phần mềm (recipe), reboot, dung lượng và số liệu của server. Mọi thao tác chạm Linux đi
 * qua Job → typed op của agent (service.control trong job service.<action>, software.install/remove, system.reboot).
 */
final class ServerOpsController
{
    /** Recipe không gỡ được (agent cũng từ chối): nền tảng của quota/ACL/tường lửa. */
    public const CORE_RECIPES = ['acl', 'quota', 'nftables'];

    public function __construct(
        private readonly Access $access,
        private readonly JobDispatcher $dispatcher,
        private readonly JobPresenter $jobs,
        private readonly MetricsCollector $collector,
        private readonly MetricsQuery $metrics,
    ) {}

    public function services(Request $request, string $id): JsonResponse
    {
        $s = $this->find($request, $id);
        if (! ServerService::query()->where('server_id', $s->id)->exists()) {
            try {
                $this->collector->services($s); // lần đầu: hỏi agent ngay, sau đó itso:metrics-collect cập nhật
            } catch (AgentUnavailable) {
                // Trả danh sách rỗng; UI hiện trạng thái agent.
            }
        }
        $versions = (array) ($s->refresh()->observed_facts['service_versions'] ?? []);
        $q = ServerService::query()->where('server_id', $s->id);
        Listing::search($request, $q, ['server_services.name']);

        return response()->json(Listing::page($request, $q, ['name' => 'server_services.name'], 'name',
            fn (ServerService $r): array => [
                'name' => $r->name, 'active' => $r->observed_state === 'active', 'enabled' => (bool) $r->enabled,
                'version' => is_string($versions[$r->name] ?? null) ? $versions[$r->name] : null,
                'since' => $r->observed_at?->toIso8601String(),
            ]));
    }

    public function controlService(Request $request, string $id, string $service, string $action): JsonResponse
    {
        $s = $this->find($request, $id);
        if (! in_array($service, MetricsCollector::SERVICES, true)) {
            throw ApiProblem::field('service', 'Dịch vụ không nằm trong allowlist.');
        }
        if (! in_array($action, ['start', 'stop', 'restart', 'reload'], true)) {
            throw ApiProblem::field('action', 'Hành động không hợp lệ.');
        }
        // Loại job theo hành động (service.restart…) để nhãn UI/audit rõ; bước luôn là op service.control.
        $this->ensureNoActiveJob($s, ['service.start', 'service.stop', 'service.restart', 'service.reload'], 'name', $service);
        $spec = (new JobSpec('service.'.$action, $s, $s->id, maxAttempts: 1, timeoutSec: 120))
            ->step('service.control', ['name' => $service, 'action' => $action]);

        return $this->accepted($this->dispatcher->dispatch($spec, $this->actor($request)));
    }

    public function reboot(Request $request, string $id): JsonResponse
    {
        $s = $this->find($request, $id);
        $this->ensureNoActiveJob($s, ['server.reboot']);
        $spec = (new JobSpec('server.reboot', $s, $s->id, maxAttempts: 1, timeoutSec: 60))
            ->step('system.reboot', ['delay_sec' => 60, 'reason' => 'Yêu cầu từ panel (user #'.$this->actor($request)->id.')']);

        return $this->accepted($this->dispatcher->dispatch($spec, $this->actor($request)));
    }

    public function software(Request $request, string $id): JsonResponse
    {
        $s = $this->find($request, $id);
        $rows = ServerSoftware::query()->where('server_id', $s->id)->get()->keyBy('software_key');
        $q = SoftwareCatalog::query();
        Listing::search($request, $q, ['software_catalog.key', 'software_catalog.name']);

        return response()->json(Listing::page($request, $q, ['name' => 'software_catalog.name', 'key' => 'software_catalog.key'],
            'key', fn (SoftwareCatalog $c): array => self::presentSoftware($c, $rows->get($c->key))));
    }

    public function manageSoftware(Request $request, string $id, string $key, string $action): JsonResponse
    {
        $s = $this->find($request, $id);
        $c = SoftwareCatalog::query()->where('key', $key)->first();
        if (! $c instanceof SoftwareCatalog) {
            throw new NotFoundHttpException;
        }
        if ($action === 'upgrade') {
            throw new ApiProblem(409, 'invalid_state_transition', 'Chưa hỗ trợ nâng cấp',
                'Recipe cài bản theo kho apt của Ubuntu; nâng cấp đi theo cập nhật hệ điều hành.');
        }
        if (! in_array($action, ['install', 'remove'], true)) {
            throw ApiProblem::field('action', 'Hành động không hợp lệ.');
        }
        if ($action === 'remove' && in_array($key, self::CORE_RECIPES, true)) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Không gỡ được phần mềm nền tảng',
                "Gói {$key} cần cho quota/ACL/tường lửa của panel.");
        }
        $job = DB::transaction(function () use ($request, $s, $key, $action): Job {
            $row = ServerSoftware::query()->where('server_id', $s->id)->where('software_key', $key)->lockForUpdate()->first()
                ?? new ServerSoftware(['server_id' => $s->id, 'software_key' => $key]);
            if (in_array($row->status, ['provisioning', 'deleting'], true)) {
                throw new ApiProblem(409, 'resource_locked', 'Đang có job khác', "Phần mềm {$key} đang được cài/gỡ.");
            }
            $spec = (new JobSpec('software.'.$action, $s, $s->id, maxAttempts: 2, timeoutSec: 900))
                ->step('software.'.$action, ['recipe' => $key]);
            $job = $this->dispatcher->dispatch($spec, $this->actor($request));
            $row->status = $action === 'install' ? 'provisioning' : 'deleting';
            $row->spec_version = $row->exists ? $row->spec_version + 1 : 1;
            $row->last_job_id = $job->id;
            $row->save();

            return $job;
        });

        return $this->accepted($job);
    }

    public function capacity(Request $request, string $id): JsonResponse
    {
        $s = $this->find($request, $id);
        $c = $this->collector->capacity($s);

        return response()->json(['data' => [
            'server' => ['uuid' => $s->uuid, 'name' => $s->name],
            'cpu_cores' => $c->cpu_cores, 'ram_mb' => $c->ram_mb, 'disk_mb' => $c->disk_mb,
            'allocated_cpu_pct' => $c->allocated_cpu_pct, 'allocated_ram_mb' => $c->allocated_ram_mb,
            'allocated_disk_mb' => $c->allocated_disk_mb, 'account_count' => $c->account_count,
            'max_accounts' => $c->max_accounts,
            'accepting_new' => $s->accepting_new_accounts && $c->account_count < $c->max_accounts,
            'updated_at' => $c->updated_at->toIso8601String(),
        ]]);
    }

    public function serverMetrics(Request $request, string $id): JsonResponse
    {
        $s = $this->find($request, $id);
        [$metric, $range] = MetricsQuery::validate($request);

        return response()->json(['data' => $this->metrics->series('server', $s->uuid, $s->id, null, $metric, $range)]);
    }

    public function accountMetrics(Request $request, string $id): JsonResponse
    {
        $a = Str::isUuid($id) ? $this->access->accounts($this->actor($request))->where('hosting_accounts.uuid', $id)->first() : null;
        if (! $a instanceof HostingAccount) {
            throw new NotFoundHttpException;
        }
        [$metric, $range] = MetricsQuery::validate($request, ['cpu_pct', 'ram_pct', 'disk_pct']);

        return response()->json(['data' => $this->metrics->series('hosting_account', $a->uuid, $a->server_id, $a->id, $metric, $range)]);
    }

    /** @return array<string, mixed> */
    public static function presentSoftware(SoftwareCatalog $c, ?ServerSoftware $row): array
    {
        $latest = is_string($c->versions[0] ?? null) ? $c->versions[0] : 'apt';
        $installed = $row !== null && is_string($row->version) && $row->version !== '' ? $row->version : null;
        $state = match ($row?->status) {
            'provisioning', 'deleting' => 'installing',
            'failed' => 'failed',
            'ready' => $installed !== null ? 'installed' : 'available',
            default => 'available',
        };

        return ['key' => $c->key, 'name' => $c->name, 'category' => $c->category, 'installed_version' => $installed,
            'latest_version' => $latest, 'state' => $state];
    }

    /** @param list<string> $types */
    private function ensureNoActiveJob(Server $s, array $types, ?string $param = null, ?string $value = null): void
    {
        $q = Job::query()->where('server_id', $s->id)->whereIn('type', $types)->whereIn('state', ['queued', 'running']);
        if ($param !== null) {
            $q->whereExists(fn ($w) => $w->from('job_steps')->whereColumn('job_steps.job_id', 'jobs.id')
                ->whereRaw('job_steps.params_redacted ->> ? = ?', [$param, $value]));
        }
        if ($q->where('created_at', '>=', Carbon::now()->subHour())->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Đang có job khác', 'Chờ job trước kết thúc rồi thử lại.');
        }
    }

    private function accepted(Job $job): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function find(Request $request, string $id): Server
    {
        $s = Str::isUuid($id) ? $this->access->servers($this->actor($request))->where('servers.uuid', $id)->first() : null;
        if (! $s instanceof Server) {
            throw new NotFoundHttpException;
        }

        return $s;
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
