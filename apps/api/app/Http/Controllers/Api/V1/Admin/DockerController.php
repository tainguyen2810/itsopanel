<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Docker\DockerHostService;
use App\Domain\Docker\DockerInventory;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\ComposeProject;
use App\Models\DockerContainer;
use App\Models\Job;
use App\Models\PortAllocation;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Prompt 10.4: Docker trên server (D-94…D-98) — trạng thái, bật Docker, DOCKER-USER, container/image/volume/network,
 * cổng đã cấp. Chỉ realm Admin; ADMIN chỉ thấy server được giao (Access::servers).
 */
final class DockerController
{
    public function __construct(private readonly Access $access, private readonly DockerHostService $hosts,
        private readonly DockerInventory $inventory, private readonly JobPresenter $jobs) {}

    public function show(Request $request, string $id): JsonResponse
    {
        return response()->json(['data' => $this->hosts->present($this->server($request, $id))]);
    }

    public function enable(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->hosts->enable($this->actor($request), $this->server($request, $id)));
    }

    public function syncFirewall(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->hosts->syncFirewall($this->actor($request), $this->server($request, $id)));
    }

    public function containers(Request $request, string $id): JsonResponse
    {
        $s = $this->server($request, $id);
        $stats = $this->inventory->refreshContainers($s);
        $names = ComposeProject::withTrashed()->where('server_id', $s->id)->pluck('name', 'id')->all();
        $q = DockerContainer::query()->where('server_id', $s->id);
        Listing::search($request, $q, ['containers.name', 'containers.image']);

        return response()->json(Listing::page($request, $q, ['name' => 'containers.name', 'state' => 'containers.state'], 'name',
            fn (DockerContainer $c): array => DockerInventory::presentContainer($c, $stats, $names)));
    }

    public function controlContainer(Request $request, string $id, string $container, string $action): JsonResponse
    {
        return $this->accepted($this->inventory->control($this->actor($request), $this->server($request, $id), $container, $action));
    }

    public function logs(Request $request, string $id, string $container): JsonResponse
    {
        $s = $this->server($request, $id);
        $lines = $request->query('lines', '200');
        $n = is_string($lines) && ctype_digit($lines) ? max(1, min(5000, (int) $lines)) : 200;

        return response()->json(['data' => $this->inventory->logs($s, $container, $n)]);
    }

    public function images(Request $request, string $id): JsonResponse
    {
        return $this->arrayPage($request, $this->inventory->images($this->server($request, $id)), ['tags']);
    }

    public function volumes(Request $request, string $id): JsonResponse
    {
        return $this->arrayPage($request, $this->inventory->volumes($this->server($request, $id)), ['name']);
    }

    public function networks(Request $request, string $id): JsonResponse
    {
        return $this->arrayPage($request, $this->inventory->networks($this->server($request, $id)), ['name']);
    }

    public function prune(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->inventory->prune($this->actor($request), $this->server($request, $id)));
    }

    public function deleteVolume(Request $request, string $id, string $volume): JsonResponse
    {
        return $this->accepted($this->inventory->removeVolume($this->actor($request), $this->server($request, $id), $volume));
    }

    public function portAllocations(Request $request, string $id): JsonResponse
    {
        $s = $this->server($request, $id);
        $projects = ComposeProject::withTrashed()->where('server_id', $s->id)->get(['id', 'uuid', 'name'])->keyBy('id');
        $q = PortAllocation::query()->where('server_id', $s->id);

        return response()->json(Listing::page($request, $q, ['port' => 'port_allocations.port'], 'port',
            fn (PortAllocation $a): array => ['port' => $a->port, 'protocol' => $a->protocol,
                'server' => ['uuid' => $s->uuid, 'name' => $s->name],
                'compose_project' => ['uuid' => (string) $projects->get($a->compose_project_id)?->uuid,
                    'name' => (string) $projects->get($a->compose_project_id)?->name],
                'service' => $a->service, 'container_port' => $a->container_port, 'allocated_at' => $a->created_at->toIso8601String()]));
    }

    /**
     * Danh sách đọc trực tiếp từ agent (không cache): lọc `q`, cắt theo limit.
     *
     * @param  list<array<string, mixed>>  $rows
     * @param  list<string>  $fields
     */
    private function arrayPage(Request $request, array $rows, array $fields): JsonResponse
    {
        $q = $request->query('q');
        if (is_string($q) && trim($q) !== '') {
            $needle = mb_strtolower(trim($q));
            $rows = array_values(array_filter($rows, function (array $r) use ($fields, $needle): bool {
                foreach ($fields as $f) {
                    foreach ((array) $r[$f] as $v) {
                        if (str_contains(mb_strtolower((string) $v), $needle)) {
                            return true;
                        }
                    }
                }

                return false;
            }));
        }
        $limit = $request->query('limit', '200');
        $limit = is_string($limit) && ctype_digit($limit) ? max(1, min(200, (int) $limit)) : 200;

        return response()->json(['data' => array_slice($rows, 0, $limit), 'meta' => ['next_cursor' => null, 'limit' => $limit]]);
    }

    private function accepted(Job $job): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function server(Request $request, string $id): Server
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
