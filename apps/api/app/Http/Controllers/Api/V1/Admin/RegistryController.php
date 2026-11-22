<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Realm;
use App\Domain\Docker\RegistryService;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\Registry;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** Prompt 10.4: registry image riêng (D-98) — chỉ SUPER_ADMIN (docker.manage); mật khẩu không bao giờ trả ra. */
final class RegistryController
{
    public function __construct(private readonly RegistryService $registries, private readonly JobPresenter $jobs) {}

    public function index(Request $request): JsonResponse
    {
        $q = Registry::query();
        Listing::search($request, $q, ['registries.name', 'registries.url']);

        return response()->json(Listing::page($request, $q, ['name' => 'registries.name', 'created_at' => 'registries.created_at'],
            'name', fn (Registry $r): array => RegistryService::present($r)));
    }

    public function store(Request $request): JsonResponse
    {
        HostingPackageController::rejectUnknown($request, ['name', 'url', 'username', 'password']);
        $in = $request->validate(['name' => ['required', 'string', 'max:80'], 'url' => ['required', 'string', 'max:500'],
            'username' => ['sometimes', 'nullable', 'string', 'max:200'], 'password' => ['sometimes', 'nullable', 'string', 'max:1024']]);
        $r = $this->registries->create($this->actor($request), $in);

        return response()->json(['data' => RegistryService::present($r)], 201);
    }

    public function destroy(Request $request, string $id): Response
    {
        $this->registries->delete($this->actor($request), $this->find($id));

        return response()->noContent();
    }

    public function test(Request $request, string $id): JsonResponse
    {
        $job = $this->registries->test($this->actor($request), $this->find($id));
        $data = $this->jobs->job($job->refresh(), Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function find(string $id): Registry
    {
        $r = Str::isUuid($id) ? Registry::query()->where('uuid', $id)->first() : null;
        if (! $r instanceof Registry) {
            throw new NotFoundHttpException;
        }

        return $r;
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
