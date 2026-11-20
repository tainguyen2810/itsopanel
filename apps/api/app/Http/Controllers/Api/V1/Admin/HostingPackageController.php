<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Realm;
use App\Domain\Audit\AuditLogger;
use App\Domain\Hosting\PackageLimits;
use App\Domain\Hosting\ProvisioningService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\HostingPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\HostingPackageVersion;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * /admin/hosting-packages (Prompt 3.5). Đổi `limits` tạo phiên bản mới bất biến (D-43); account giữ phiên bản cũ
 * đến khi đổi gói hoặc chạy migrate-accounts.
 */
final class HostingPackageController
{
    public function __construct(
        private readonly HostingPresenter $present,
        private readonly ProvisioningService $provisioning,
        private readonly JobPresenter $jobs,
        private readonly AuditLogger $audit,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $q = HostingPackage::query();
        Listing::search($request, $q, ['hosting_packages.code', 'hosting_packages.name']);

        return response()->json(Listing::page($request, $q,
            ['code' => 'hosting_packages.code', 'name' => 'hosting_packages.name', 'created_at' => 'hosting_packages.created_at'],
            'code', fn (HostingPackage $p): array => $this->present->package($p)));
    }

    public function show(string $id): JsonResponse
    {
        $p = $this->find($id);

        return response()->json(['data' => $this->present->package($p)])->header('ETag', HostingPresenter::packageEtag($p));
    }

    public function store(Request $request): JsonResponse
    {
        self::rejectUnknown($request, ['code', 'name', 'description', 'limits']);
        $in = $request->validate(array_merge([
            'code' => ['required', 'string', 'regex:/^[a-z][a-z0-9-]{1,31}$/'],
            'name' => ['required', 'string', 'min:1', 'max:80'],
            'description' => ['sometimes', 'nullable', 'string', 'max:500'],
        ], PackageLimits::rules()));
        if (HostingPackage::query()->withTrashed()->where('code', $in['code'])->exists()) {
            throw ApiProblem::conflict("Mã gói {$in['code']} đã được dùng.");
        }
        $actor = $this->actor($request);
        $p = DB::transaction(function () use ($in, $actor): HostingPackage {
            $p = HostingPackage::query()->create(['code' => $in['code'], 'name' => $in['name'],
                'description' => $in['description'] ?? null, 'current_version' => 1, 'is_active' => true]);
            HostingPackageVersion::query()->create(array_merge(PackageLimits::columns($in['limits']),
                ['package_id' => $p->id, 'version' => 1, 'created_by_user_id' => $actor->id]));
            $this->audit->record('hosting_package.create', $p, ['code' => $p->code], 'success', null, null, $actor);

            return $p;
        });

        return response()->json(['data' => $this->present->package($p->refresh())], 201)
            ->header('ETag', HostingPresenter::packageEtag($p));
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $p = $this->find($id);
        $ifMatch = $request->header('If-Match');
        if (is_string($ifMatch) && $ifMatch !== '' && $ifMatch !== HostingPresenter::packageEtag($p)) {
            throw new ApiProblem(412, 'precondition_failed', 'Gói đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        self::rejectUnknown($request, ['name', 'description', 'is_active', 'limits']);
        $rules = ['name' => ['sometimes', 'string', 'min:1', 'max:80'], 'description' => ['sometimes', 'nullable', 'string', 'max:500'],
            'is_active' => ['sometimes', 'boolean']];
        if ($request->has('limits')) {
            $rules = array_merge($rules, PackageLimits::rules());
        }
        $in = $request->validate($rules);
        $actor = $this->actor($request);
        DB::transaction(function () use ($p, $in, $actor): void {
            /** @var HostingPackage $p */
            $p = HostingPackage::query()->lockForUpdate()->findOrFail($p->id);
            $changes = [];
            foreach (['name', 'description', 'is_active'] as $k) {
                if (array_key_exists($k, $in) && $p->getAttribute($k) !== $in[$k]) {
                    $changes[$k] = ['from' => $p->getAttribute($k), 'to' => $in[$k]];
                    $p->setAttribute($k, $in[$k]);
                }
            }
            if (isset($in['limits'])) {
                $cur = $this->provisioning->currentVersion($p);
                if (! PackageLimits::same(PackageLimits::of($cur), $in['limits'])) {
                    $next = $p->current_version + 1;
                    HostingPackageVersion::query()->create(array_merge(PackageLimits::columns($in['limits']),
                        ['package_id' => $p->id, 'version' => $next, 'created_by_user_id' => $actor->id]));
                    $changes['version'] = ['from' => $p->current_version, 'to' => $next];
                    $p->current_version = $next;
                }
            }
            if ($changes !== []) {
                $p->touch();
                $p->save();
                $this->audit->record('hosting_package.update', $p, $changes, 'success', null, null, $actor);
            }
        });
        $p->refresh();

        return response()->json(['data' => $this->present->package($p)])->header('ETag', HostingPresenter::packageEtag($p));
    }

    public function destroy(Request $request, string $id): Response
    {
        $p = $this->find($id);
        $versions = HostingPackageVersion::query()->where('package_id', $p->id)->pluck('id');
        if (HostingAccount::query()->whereIn('package_version_id', $versions)->where('lifecycle_state', '<>', 'purged')->exists()) {
            throw ApiProblem::conflict('Gói còn account đang dùng; đổi gói cho các account trước hoặc ngừng bán (is_active=false).');
        }
        $p->delete();
        $this->audit->record('hosting_package.delete', $p, ['code' => $p->code], 'success', null, null, $this->actor($request));

        return response()->noContent();
    }

    public function versions(Request $request, string $id): JsonResponse
    {
        $p = $this->find($id);
        $q = HostingPackageVersion::query()->where('package_id', $p->id);

        return response()->json(Listing::page($request, $q, ['version' => 'hosting_package_versions.version'], '-version',
            fn (HostingPackageVersion $v): array => $this->present->version($v, $p)));
    }

    public function migrateAccounts(Request $request, string $id, string $version): JsonResponse
    {
        $p = $this->find($id);
        $v = ctype_digit($version) ? HostingPackageVersion::query()->where('package_id', $p->id)->where('version', (int) $version)->first() : null;
        if (! $v instanceof HostingPackageVersion) {
            throw new NotFoundHttpException;
        }
        $job = $this->provisioning->migrateVersion($this->actor($request), $p, $v);
        $data = $this->jobs->job($job->refresh(), Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function find(string $id): HostingPackage
    {
        $p = Str::isUuid($id) ? HostingPackage::query()->where('uuid', $id)->first() : null;
        if (! $p instanceof HostingPackage) {
            throw new NotFoundHttpException;
        }

        return $p;
    }

    /** @param  list<string>  $allowed */
    public static function rejectUnknown(Request $request, array $allowed): void
    {
        $unknown = array_diff(array_keys($request->json()->all()), $allowed);
        if ($unknown !== []) {
            throw ApiProblem::field((string) reset($unknown), 'Trường không được hỗ trợ.');
        }
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
