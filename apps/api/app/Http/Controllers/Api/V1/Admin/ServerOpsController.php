<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Servers\AccountUsageQuery;
use App\Domain\Servers\MetricsCollector;
use App\Domain\Servers\MetricsQuery;
use App\Domain\Servers\OsUpdates;
use App\Domain\Servers\SoftwareService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Http\Support\OffsetPage;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\Server;
use App\Models\ServerService;
use App\Models\SoftwareCatalog;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Prompt 4.5: dịch vụ, phần mềm (recipe), reboot, dung lượng và số liệu của server. Mọi thao tác chạm Linux đi
 * qua Job → typed op của agent (service.control trong job service.<action>, software.install/remove/upgrade, os.auto_updates, system.reboot).
 */
final class ServerOpsController
{
    public function __construct(
        private readonly Access $access,
        private readonly JobDispatcher $dispatcher,
        private readonly JobPresenter $jobs,
        private readonly MetricsCollector $collector,
        private readonly MetricsQuery $metrics,
        private readonly AccountUsageQuery $usage,
        private readonly SoftwareService $software,
        private readonly AuditLogger $audit,
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
        $rows = $this->software->rows($s);
        $q = SoftwareCatalog::query();
        Listing::search($request, $q, ['software_catalog.key', 'software_catalog.name']);

        return response()->json(Listing::page($request, $q, ['name' => 'software_catalog.name', 'key' => 'software_catalog.key'],
            'key', fn (SoftwareCatalog $c): array => $this->software->present($s, $c, $rows[$c->key] ?? null, $rows)));
    }

    public function manageSoftware(Request $request, string $id, string $key, string $action): JsonResponse
    {
        $s = $this->find($request, $id);
        $c = SoftwareCatalog::query()->where('key', $key)->first();
        if (! $c instanceof SoftwareCatalog) {
            throw new NotFoundHttpException;
        }

        return $this->accepted($this->software->manage($this->actor($request), $s, $c, $action));
    }

    public function osUpdates(Request $request, string $id): JsonResponse
    {
        return response()->json(['data' => OsUpdates::get($this->find($request, $id))]);
    }

    /** Bật/tắt unattended-upgrades (chỉ SUPER_ADMIN); không bao giờ tự reboot (D-100). */
    public function putOsUpdates(Request $request, string $id): JsonResponse
    {
        $actor = $this->actor($request);
        if ($actor->roleKey() !== 'SUPER_ADMIN') {
            throw ApiProblem::forbidden('Chỉ Super Admin đổi cập nhật tự động của hệ điều hành.');
        }
        $s = $this->find($request, $id);
        $in = $request->validate(['enabled' => ['required', 'boolean'], 'security_only' => ['sometimes', 'boolean']]);
        $cur = OsUpdates::get($s);
        $next = ['enabled' => (bool) $in['enabled'], 'security_only' => (bool) ($in['security_only'] ?? $cur['security_only'])];
        $this->ensureNoActiveJob($s, ['software.os_updates']);
        $spec = (new JobSpec('software.os_updates', $s, $s->id, maxAttempts: 2, timeoutSec: 300))
            ->step('os.auto_updates', $next);
        $job = $this->dispatcher->dispatch($spec, $actor);
        $this->audit->record('software.os_updates', $s, ['from' => ['enabled' => $cur['enabled'], 'security_only' => $cur['security_only']],
            'to' => $next], 'success', $s->id, $job->id, $actor);

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
        [$metric, $range] = MetricsQuery::validate($request, MetricsQuery::ACCOUNT_METRICS);

        return response()->json(['data' => $this->metrics->accountSeries($a, $metric, $range)]);
    }

    /**
     * Số liệu cgroup gần nhất theo account trên server (top account, D-101). ADMIN chỉ thấy server được giao và
     * account trong phạm vi. Tối đa vài trăm account/server nên sắp xếp/lọc trong bộ nhớ; cursor là vị trí.
     */
    public function serverAccountUsage(Request $request, string $id): JsonResponse
    {
        $s = $this->find($request, $id);
        $sort = $request->query('sort', '-cpu_pct');
        $keys = ['cpu_pct' => 'cpu_pct', 'ram_mb' => 'ram_mb', 'io_write_bps' => 'io_write_bps', 'io_read_bps' => 'io_read_bps',
            'disk_mb' => 'disk_mb', 'tasks' => 'tasks', 'username' => 'username'];
        if (! is_string($sort) || ! isset($keys[ltrim($sort, '-')])) {
            throw ApiProblem::field('sort', 'sort không hợp lệ.');
        }
        OffsetPage::params($request); // kiểm limit/cursor trước khi đọc số liệu
        $q = $this->access->accounts($this->actor($request))->where('server_id', $s->id)
            ->whereIn('lifecycle_state', ['active', 'suspended']);
        Listing::search($request, $q, ['hosting_accounts.username']);
        $rows = $this->usage->rows($s, $q->orderBy('username')->get());
        $key = ltrim($sort, '-');
        $desc = str_starts_with($sort, '-');
        usort($rows, function (array $a, array $b) use ($key, $desc): int {
            $va = $key === 'username' ? $a['hosting_account']['username'] : $a[$key];
            $vb = $key === 'username' ? $b['hosting_account']['username'] : $b[$key];
            $c = $desc ? $vb <=> $va : $va <=> $vb;

            return $c !== 0 ? $c : strcmp($a['hosting_account']['username'], $b['hosting_account']['username']);
        });

        return response()->json(OffsetPage::ofArray($request, $rows));
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
