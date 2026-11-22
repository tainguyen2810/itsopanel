<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Docker\ComposeService;
use App\Domain\Docker\ComposeTemplates;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\ComposeProject;
use App\Models\ComposeRevision;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Prompt 10.4: compose project (D-96, D-97). YAML luôn qua compose.validate của agent trước khi lưu thành revision
 * chạy được; override chỉ SUPER_ADMIN; ADMIN chỉ trên server được giao.
 */
final class ComposeController
{
    private const INPUT = ['server_uuid', 'name', 'compose_yaml', 'env', 'template', 'overrides'];

    public function __construct(private readonly Access $access, private readonly ComposeService $compose,
        private readonly JobPresenter $jobs) {}

    public function index(Request $request): JsonResponse
    {
        $q = ComposeProject::query()->whereIn('server_id', $this->access->servers($this->actor($request))->select('servers.id'))
            ->with(['server', 'currentRevision']);
        $srv = $request->input('filter.server');
        if (is_string($srv)) {
            $q->where('server_id', Server::query()->where('uuid', $srv)->value('id') ?? 0);
        }
        Listing::search($request, $q, ['compose_projects.name']);

        return response()->json(Listing::page($request, $q, ['name' => 'compose_projects.name',
            'created_at' => 'compose_projects.created_at'], 'name', fn (ComposeProject $p): array => $this->compose->present($p)));
    }

    public function store(Request $request): JsonResponse
    {
        HostingPackageController::rejectUnknown($request, self::INPUT);
        $in = $request->validate($this->rules(true));
        $s = $this->access->servers($this->actor($request))->where('servers.uuid', $in['server_uuid'])->first();
        if (! $s instanceof Server) {
            throw ApiProblem::field('server_uuid', 'Không tìm thấy máy chủ trong phạm vi.');
        }
        [, $job] = $this->compose->create($this->actor($request), $s, $request->json()->all());

        return $this->accepted($job);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $p = $this->find($request, $id);

        return response()->json(['data' => $this->compose->present($p)])->header('ETag', ComposeService::etag($p));
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $p = $this->find($request, $id);
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== ComposeService::etag($p)) {
            throw new ApiProblem(412, 'precondition_failed', 'Project đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        HostingPackageController::rejectUnknown($request, self::INPUT);
        $request->validate($this->rules(false));

        return $this->accepted($this->compose->update($this->actor($request), $p, $request->json()->all()));
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->compose->delete($this->actor($request), $this->find($request, $id)));
    }

    public function action(Request $request, string $id, string $action): JsonResponse
    {
        return $this->accepted($this->compose->action($this->actor($request), $this->find($request, $id), $action));
    }

    public function preview(Request $request): JsonResponse
    {
        HostingPackageController::rejectUnknown($request, ['server_uuid', 'compose_yaml', 'overrides']);
        $in = $request->validate(['server_uuid' => ['required', 'uuid'], 'compose_yaml' => ['required', 'string', 'max:262144'],
            'overrides' => ['sometimes', 'array', 'max:10']]);
        $s = $this->access->servers($this->actor($request))->where('servers.uuid', $in['server_uuid'])->first();
        if (! $s instanceof Server) {
            throw ApiProblem::field('server_uuid', 'Không tìm thấy máy chủ trong phạm vi.');
        }

        return response()->json(['data' => $this->compose->preview($this->actor($request), $s, (string) $in['compose_yaml'],
            $in['overrides'] ?? [])]);
    }

    public function revisions(Request $request, string $id): JsonResponse
    {
        $p = $this->find($request, $id);
        $q = ComposeRevision::query()->where('project_id', $p->id);
        $users = User::query()->whereIn('id', ComposeRevision::query()->where('project_id', $p->id)->whereNotNull('created_by_user_id')
            ->select('created_by_user_id'))->get()->keyBy('id');

        return response()->json(Listing::page($request, $q, ['number' => 'compose_revisions.number'], '-number',
            function (ComposeRevision $r) use ($p, $users): array {
                $u = $r->created_by_user_id !== null ? $users->get($r->created_by_user_id) : null;

                return ['number' => $r->number, 'compose_yaml' => $r->yaml, 'validated_yaml' => $r->validated_yaml, 'ok' => $r->ok,
                    'findings' => $r->findings_count, 'overrides' => count($r->overrides),
                    'created_by' => $u instanceof User ? ['uuid' => $u->uuid, 'name' => $u->name, 'email' => $u->email] : null,
                    'created_at' => $r->created_at->toIso8601String(), 'current' => $r->id === $p->current_revision_id];
            }));
    }

    public function updateImages(Request $request, string $id): JsonResponse
    {
        $in = $this->imageBody($request);

        return $this->accepted($this->compose->updateImages($this->actor($request), $this->find($request, $id), $in));
    }

    public function rollbackImages(Request $request, string $id): JsonResponse
    {
        $in = $this->imageBody($request);

        return $this->accepted($this->compose->rollbackImages($this->actor($request), $this->find($request, $id), $in));
    }

    public function templates(Request $request): JsonResponse
    {
        $rows = ComposeTemplates::ALL;
        $q = $request->query('q');
        if (is_string($q) && trim($q) !== '') {
            $rows = array_values(array_filter($rows, fn (array $t): bool => str_contains(mb_strtolower($t['name'].' '.$t['category']), mb_strtolower(trim($q)))));
        }

        return response()->json(['data' => $rows, 'meta' => ['next_cursor' => null, 'limit' => max(1, count($rows))]]);
    }

    /** @return list<mixed> */
    private function imageBody(Request $request): array
    {
        HostingPackageController::rejectUnknown($request, ['services']);
        $in = $request->validate(['services' => ['sometimes', 'array', 'max:50'], 'services.*' => ['string', 'regex:/^[a-z0-9][a-z0-9_.-]{0,62}$/']]);

        return array_values((array) ($in['services'] ?? []));
    }

    /** @return array<string, list<string>> */
    private function rules(bool $create): array
    {
        $req = $create ? 'required' : 'sometimes';

        return [
            'server_uuid' => [$req, 'uuid'], 'name' => [$req, 'string', 'regex:/^[a-z0-9][a-z0-9_-]{0,62}$/'],
            'compose_yaml' => [$req, 'string', 'max:262144'], 'env' => ['sometimes', 'nullable', 'array', 'max:200'],
            'template' => ['sometimes', 'nullable', 'string', 'regex:/^[a-z0-9-]{1,64}$/'],
            'overrides' => ['sometimes', 'array', 'max:10'],
        ];
    }

    private function accepted(Job $job): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function find(Request $request, string $id): ComposeProject
    {
        $p = Str::isUuid($id) ? ComposeProject::query()->where('uuid', $id)
            ->whereIn('server_id', $this->access->servers($this->actor($request))->select('servers.id'))->first() : null;
        if (! $p instanceof ComposeProject) {
            throw new NotFoundHttpException;
        }

        return $p;
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
