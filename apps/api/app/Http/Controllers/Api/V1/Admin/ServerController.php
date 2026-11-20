<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Domain\Audit\AuditLogger;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\ServerPresenter;
use App\Http\Support\Listing;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * /admin/servers (Prompt 3.4): đọc + sửa thuộc tính desired (name, role_tags, accepting_new_accounts).
 * ADMIN chỉ thấy server trong phạm vi; ngoài phạm vi → 404. Thêm server/enrollment: Phase 9.
 */
final class ServerController
{
    public function __construct(
        private readonly Access $access,
        private readonly ServerPresenter $present,
        private readonly AuditLogger $audit,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $q = $this->access->servers($this->actor($request));
        Listing::search($request, $q, ['servers.name', 'servers.hostname']);

        return response()->json(Listing::page($request, $q,
            ['created_at' => 'servers.created_at', 'name' => 'servers.name', 'status' => 'servers.status'],
            'name', fn (Server $s): array => $this->present->server($s)));
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $s = $this->find($request, $id);

        return response()->json(['data' => $this->present->server($s)])->header('ETag', ServerPresenter::etag($s));
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $s = $this->find($request, $id);
        $ifMatch = $request->header('If-Match');
        if (is_string($ifMatch) && $ifMatch !== '' && $ifMatch !== ServerPresenter::etag($s)) {
            throw new ApiProblem(412, 'precondition_failed', 'Server đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        $unknown = array_diff(array_keys($request->json()->all()), ['name', 'role_tags', 'accepting_new_accounts']);
        if ($unknown !== []) {
            throw ApiProblem::field((string) reset($unknown), 'Không sửa được trường này.');
        }
        $in = $request->validate([
            'name' => ['sometimes', 'string', 'regex:/^[a-z0-9][a-z0-9-]{1,62}$/'],
            'role_tags' => ['sometimes', 'array'],
            'role_tags.*' => ['string', 'in:web,db,backup,docker', 'distinct'],
            'accepting_new_accounts' => ['sometimes', 'boolean'],
        ]);
        if (isset($in['name']) && $in['name'] !== $s->name
            && Server::query()->withTrashed()->where('name', $in['name'])->exists()) {
            throw ApiProblem::conflict('Tên server đã được dùng.');
        }
        $changes = [];
        foreach ($in as $k => $v) {
            $old = $s->getAttribute($k);
            if ($old !== $v) {
                $changes[$k] = ['from' => $old, 'to' => $v];
                $s->setAttribute($k, $v);
            }
        }
        if ($changes !== []) {
            $s->spec_version++;
            $s->save();
            $this->audit->record('server.update', $s, $changes);
        }
        $s->refresh();

        return response()->json(['data' => $this->present->server($s)])->header('ETag', ServerPresenter::etag($s));
    }

    private function find(Request $request, string $id): Server
    {
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $id) !== 1) {
            throw new NotFoundHttpException;
        }
        $s = $this->access->servers($this->actor($request))->where('uuid', $id)->first();
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
