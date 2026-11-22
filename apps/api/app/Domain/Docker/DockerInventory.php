<?php

declare(strict_types=1);

namespace App\Domain\Docker;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\ComposeProject;
use App\Models\DockerContainer;
use App\Models\Job;
use App\Models\PortAllocation;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Danh sách container/image/volume/network (đọc đồng bộ từ agent). Container được cache ở bảng `containers` để
 * danh sách vẫn hiện khi agent tạm mất kết nối; thao tác ghi (control, prune, xóa volume) đi qua job.
 */
final class DockerInventory
{
    public function __construct(private readonly AgentClient $agent, private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit, private readonly DockerHostService $hosts) {}

    /**
     * Làm mới cache container; trả thống kê CPU/RAM theo id (rỗng nếu agent không trả lời).
     *
     * @return array<string, array<string, mixed>>
     */
    public function refreshContainers(Server $s): array
    {
        if (! $this->hosts->host($s)->enabled) {
            return [];
        }
        try {
            $list = $this->read($s, 'docker.container.list', ['project_uuid' => null]);
        } catch (ApiProblem) {
            return [];
        }
        $projects = ComposeProject::withTrashed()->where('server_id', $s->id)->pluck('id', 'uuid')->all();
        $now = Carbon::now();
        $seen = [];
        DB::transaction(function () use ($s, $list, $projects, $now, &$seen): void {
            foreach ((array) ($list['containers'] ?? []) as $c) {
                $pid = is_string($c['project_uuid'] ?? null) ? ($projects[$c['project_uuid']] ?? null) : null;
                $seen[] = (string) $c['id'];
                DockerContainer::query()->updateOrCreate(['server_id' => $s->id, 'docker_id' => (string) $c['id']], [
                    'name' => (string) $c['name'], 'image' => (string) $c['image'], 'project_id' => $pid,
                    'service' => is_string($c['service'] ?? null) ? $c['service'] : null,
                    'state' => $c['state'] === 'dead' ? 'exited' : (string) $c['state'],
                    'health' => is_string($c['health'] ?? null) ? $c['health'] : null, 'observed_at' => $now,
                    'ports' => $pid !== null && is_string($c['service'] ?? null) ? self::portStrings((int) $pid, $c['service']) : [],
                ]);
            }
            DockerContainer::query()->where('server_id', $s->id)->whereNotIn('docker_id', $seen ?: [''])->delete();
        });
        $running = DockerContainer::query()->where('server_id', $s->id)->where('state', 'running')->limit(500)->pluck('docker_id')->all();
        if ($running === []) {
            return [];
        }
        try {
            $st = $this->read($s, 'docker.container.stats', ['ids' => array_values($running)]);
        } catch (ApiProblem) {
            return [];
        }

        return collect((array) ($st['stats'] ?? []))->filter(fn ($x): bool => is_array($x))->keyBy('id')->all();
    }

    /** @return list<string> "127.0.0.1:20001->80/tcp" */
    public static function portStrings(int $projectId, string $service): array
    {
        return array_values(PortAllocation::query()->where('compose_project_id', $projectId)->where('service', $service)->orderBy('port')->get()
            ->map(fn (PortAllocation $p): string => "127.0.0.1:{$p->port}->{$p->container_port}/{$p->protocol}")->all());
    }

    /**
     * @param  array<string, array<string, mixed>>  $stats
     * @param  array<int, string>  $projectNames
     * @return array<string, mixed> Container
     */
    public static function presentContainer(DockerContainer $c, array $stats, array $projectNames): array
    {
        $st = $stats[$c->docker_id] ?? null;
        $state = in_array($c->state, ['running', 'exited', 'paused', 'restarting', 'created'], true) ? $c->state : 'exited';

        return ['id' => $c->docker_id, 'name' => $c->name, 'image' => $c->image, 'state' => $state,
            'status' => $state, 'ports' => array_map('strval', $c->ports),
            'compose_project' => $c->project_id !== null ? ($projectNames[$c->project_id] ?? null) : null,
            'cpu_pct' => (float) ($st['cpu_pct'] ?? 0), 'mem_mb' => (float) ($st['mem_mb'] ?? 0),
            'mem_limit_mb' => isset($st['mem_limit_mb']) ? (float) $st['mem_limit_mb'] : null,
            'health' => in_array($c->health, ['healthy', 'unhealthy', 'starting'], true) ? $c->health : null,
            'created_at' => $c->observed_at->toIso8601String()];
    }

    /** @return list<array<string, mixed>> DockerImage */
    public function images(Server $s): array
    {
        $this->hosts->requireEnabled($s);
        $d = $this->read($s, 'docker.image.list', []);

        return array_map(fn (array $i): array => [
            'id' => (string) $i['id'], 'tags' => array_values(array_map('strval', (array) ($i['tags'] ?? []))),
            'size_mb' => round(((int) ($i['size_bytes'] ?? 0)) / 1048576, 1), 'created_at' => self::iso($i['created_at'] ?? null),
            'in_use' => (bool) ($i['in_use'] ?? false), 'dangling' => (bool) ($i['dangling'] ?? false), 'update_available' => false,
            'rollback_of' => ($i['rollback'] ?? false) === true ? (string) (((array) ($i['tags'] ?? []))[0] ?? '') : null,
        ], array_values(array_filter((array) ($d['images'] ?? []), 'is_array')));
    }

    /** @return list<array<string, mixed>> DockerVolume */
    public function volumes(Server $s): array
    {
        $this->hosts->requireEnabled($s);
        $d = $this->read($s, 'docker.volume.list', []);
        $names = DockerContainer::query()->where('server_id', $s->id)->pluck('name', 'docker_id')->all();
        $projects = ComposeProject::withTrashed()->where('server_id', $s->id)->pluck('name', 'uuid')->all();

        return array_map(function (array $v) use ($names, $projects): array {
            $used = array_values(array_map(fn ($id): string => (string) ($names[$id] ?? substr((string) $id, 0, 12)), (array) ($v['used_by'] ?? [])));

            return ['name' => (string) $v['name'], 'driver' => (string) ($v['driver'] ?? 'local'),
                'size_mb' => round(((int) ($v['size_bytes'] ?? 0)) / 1048576, 1), 'in_use' => $used !== [], 'used_by' => $used,
                'compose_project' => is_string($v['project_uuid'] ?? null) ? ($projects[$v['project_uuid']] ?? null) : null,
                'last_backup_at' => null];
        }, array_values(array_filter((array) ($d['volumes'] ?? []), 'is_array')));
    }

    /** @return list<array<string, mixed>> DockerNetwork */
    public function networks(Server $s): array
    {
        $this->hosts->requireEnabled($s);
        $d = $this->read($s, 'docker.network.list', []);

        return array_map(fn (array $n): array => ['id' => (string) $n['id'], 'name' => (string) $n['name'],
            'driver' => (string) ($n['driver'] ?? ''), 'containers' => (int) ($n['containers'] ?? 0), 'internal' => (bool) ($n['internal'] ?? false)],
            array_values(array_filter((array) ($d['networks'] ?? []), 'is_array')));
    }

    /** Container do panel quản lý trên server (cache; làm mới một lần nếu chưa thấy). */
    public function container(Server $s, string $id): DockerContainer
    {
        if (preg_match('/^[0-9a-f]{12,64}$/', $id) !== 1) {
            throw new NotFoundHttpException;
        }
        $find = fn (): ?DockerContainer => DockerContainer::query()->where('server_id', $s->id)
            ->where('docker_id', 'like', $id.'%')->first();
        $c = $find();
        if ($c === null) {
            $this->refreshContainers($s);
            $c = $find();
        }
        if (! $c instanceof DockerContainer || $c->project_id === null) {
            throw new NotFoundHttpException; // container ngoài panel (không có nhãn io.itso) không lộ ra
        }

        return $c;
    }

    /** @return list<string> */
    public function logs(Server $s, string $id, int $lines): array
    {
        $c = $this->container($s, $id);
        $d = $this->read($s, 'docker.container.logs', ['id' => $c->docker_id, 'lines' => $lines]);

        return array_values(array_map('strval', (array) ($d['lines'] ?? [])));
    }

    public function control(User $actor, Server $s, string $id, string $action): Job
    {
        if (! in_array($action, ['start', 'stop', 'restart'], true)) {
            throw ApiProblem::field('action', 'Hành động không hợp lệ (start, stop, restart).');
        }
        $this->hosts->requireEnabled($s);
        $c = $this->container($s, $id);
        $job = $this->jobs->dispatch((new JobSpec('docker.container_control', $s, $s->id, maxAttempts: 1, timeoutSec: 180))
            ->step('docker.container.control', ['id' => $c->docker_id, 'action' => $action]), $actor);
        $this->audit->record('docker.container_'.$action, $s, ['container' => $c->name, 'id' => $c->docker_id], 'success', $s->id, $job->id, $actor);

        return $job;
    }

    public function prune(User $actor, Server $s): Job
    {
        $this->hosts->requireEnabled($s);
        $this->hosts->ensureNoActiveJob($s, ['docker.image_prune']);
        $job = $this->jobs->dispatch((new JobSpec('docker.image_prune', $s, $s->id, maxAttempts: 1, timeoutSec: 900))
            ->step('docker.image.prune', ['keep_rollback' => true, 'dangling_only' => false]), $actor);
        $this->audit->record('docker.image_prune', $s, ['keep_rollback' => true], 'success', $s->id, $job->id, $actor);

        return $job;
    }

    public function removeVolume(User $actor, Server $s, string $name): Job
    {
        if (preg_match('/^[a-z0-9][a-z0-9_.-]{0,127}$/', $name) !== 1 || str_contains($name, '..')) {
            throw new NotFoundHttpException;
        }
        $vol = collect($this->volumes($s))->firstWhere('name', $name);
        if ($vol === null) {
            throw new NotFoundHttpException;
        }
        if ($vol['in_use']) {
            throw new ApiProblem(409, 'resource_locked', 'Volume đang được dùng',
                'Volume đang gắn vào container: '.implode(', ', $vol['used_by']).'. Dừng/xóa container trước.');
        }
        $job = $this->jobs->dispatch((new JobSpec('docker.volume_remove', $s, $s->id, maxAttempts: 1, timeoutSec: 180))
            ->step('docker.volume.remove', ['name' => $name]), $actor);
        $this->audit->record('docker.volume_remove', $s, ['volume' => $name, 'compose_project' => $vol['compose_project']],
            'success', $s->id, $job->id, $actor);

        return $job;
    }

    /**
     * Gọi op đọc của agent; lỗi → Problem 503 (agent không trả lời) hoặc 409 (Docker lỗi).
     *
     * @param  array<string, mixed>  $params
     * @return array<string, mixed>
     */
    private function read(Server $s, string $op, array $params): array
    {
        try {
            $r = $this->agent->forServer($s->id)->call($op, $params, null, null, 30.0);
        } catch (AgentUnavailable $e) {
            throw new ApiProblem(503, 'agent_unavailable', 'Agent không trả lời', mb_substr($e->getMessage(), 0, 200));
        }
        if (! $r->ok || $r->data === null) {
            $code = (string) ($r->error['code'] ?? 'internal');
            if ($code === 'not_found') {
                throw new NotFoundHttpException;
            }
            throw new ApiProblem(409, 'precondition_failed', 'Docker không trả lời', mb_substr((string) ($r->error['message'] ?? $code), 0, 300));
        }

        return $r->data;
    }

    private static function iso(mixed $v): string
    {
        try {
            return is_string($v) && $v !== '' ? Carbon::parse($v)->toIso8601String() : Carbon::now()->toIso8601String();
        } catch (\Throwable) {
            return Carbon::now()->toIso8601String();
        }
    }
}
