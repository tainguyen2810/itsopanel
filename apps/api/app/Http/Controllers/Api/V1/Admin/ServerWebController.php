<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Web\PhpCatalog;
use App\Domain\Web\ServerWebService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\JobPresenter;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Prompt 5.3: PHP Manager (/servers/{id}/php-versions…) và Nginx toàn server (/servers/{id}/nginx). Thay đổi đi qua
 * ServerWebService → job (php.version.install/remove, php.ext.install, nginx.global.apply).
 */
final class ServerWebController
{
    public function __construct(
        private readonly Access $access,
        private readonly ServerWebService $service,
        private readonly JobPresenter $jobs,
    ) {}

    public function phpVersions(Request $request, string $id): JsonResponse
    {
        $rows = $this->service->phpVersions($this->find($request, $id));

        return response()->json(['data' => $rows, 'meta' => ['next_cursor' => null, 'limit' => max(1, count($rows))]]);
    }

    public function managePhp(Request $request, string $id, string $version, string $action): JsonResponse
    {
        $s = $this->find($request, $id);
        if (preg_match('/^[5-9]\.[0-9]$/', $version) !== 1) {
            throw ApiProblem::field('version', 'Phiên bản PHP dạng X.Y.');
        }
        if (! in_array($action, ['install', 'remove'], true)) {
            throw ApiProblem::field('action', 'Hành động không hợp lệ.');
        }

        return $this->accepted($this->service->managePhp($this->actor($request), $s, $version, $action));
    }

    public function installExtensions(Request $request, string $id, string $version): JsonResponse
    {
        $s = $this->find($request, $id);
        HostingPackageController::rejectUnknown($request, ['extensions']);
        $in = $request->validate(['extensions' => ['required', 'array', 'min:1', 'max:20'],
            'extensions.*' => ['string', 'in:'.implode(',', PhpCatalog::EXTENSIONS)]]);

        return $this->accepted($this->service->installExtensions($this->actor($request), $s, $version,
            array_values(array_map('strval', $in['extensions']))));
    }

    public function nginx(Request $request, string $id): JsonResponse
    {
        $cfg = $this->service->nginx($this->find($request, $id));

        return response()->json(['data' => $cfg])->header('ETag', ServerWebService::nginxEtag($cfg));
    }

    public function updateNginx(Request $request, string $id): JsonResponse
    {
        $s = $this->find($request, $id);
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== ServerWebService::nginxEtag($this->service->nginx($s))) {
            throw new ApiProblem(412, 'precondition_failed', 'Cấu hình đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        HostingPackageController::rejectUnknown($request, ['worker_processes', 'worker_connections', 'client_max_body_size',
            'gzip', 'http2', 'server_tokens', 'updated_at']);
        $in = $request->validate([
            'worker_processes' => ['sometimes', 'string', 'regex:/^(auto|[0-9]{1,3})$/'],
            'worker_connections' => ['sometimes', 'integer', 'min:256', 'max:65535'],
            'client_max_body_size' => ['sometimes', 'string', 'regex:/^[0-9]{1,5}[kmg]?$/'],
            'gzip' => ['sometimes', 'boolean'], 'http2' => ['sometimes', 'boolean'], 'server_tokens' => ['sometimes', 'boolean'],
        ]);
        foreach (['gzip', 'http2', 'server_tokens'] as $k) {
            if (array_key_exists($k, $in)) {
                $in[$k] = (bool) $in[$k];
            }
        }
        if (isset($in['worker_connections'])) {
            $in['worker_connections'] = (int) $in['worker_connections'];
        }

        return $this->accepted($this->service->updateNginx($this->actor($request), $s, $in));
    }

    private function find(Request $request, string $id): Server
    {
        $s = Str::isUuid($id) ? $this->access->servers($this->actor($request))->where('servers.uuid', $id)->first() : null;
        if (! $s instanceof Server) {
            throw new NotFoundHttpException;
        }

        return $s;
    }

    private function accepted(Job $job): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
