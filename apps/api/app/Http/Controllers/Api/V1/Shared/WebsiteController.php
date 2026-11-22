<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Web\WebsiteService;
use App\Exceptions\ApiProblem;
use App\Http\Controllers\Api\V1\Admin\HostingPackageController;
use App\Http\Presenters\JobPresenter;
use App\Http\Presenters\WebPresenter;
use App\Http\Support\Listing;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use App\Models\WebsiteDomain;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * /admin/websites/* và /portal/websites/* (Prompt 5.3). Phạm vi dữ liệu theo Access::accounts (ADMIN: server/account
 * trong phạm vi; USER: account mình sở hữu); ngoài phạm vi → 404. Mọi thay đổi đi qua WebsiteService → job.
 */
final class WebsiteController
{
    private const SIZE = 'regex:/^[0-9]{1,5}[kmg]?$/';

    public function __construct(
        private readonly Access $access,
        private readonly WebsiteService $service,
        private readonly WebPresenter $present,
        private readonly JobPresenter $jobs,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $request->validate(['filter.hosting_account' => ['sometimes', 'uuid'], 'filter.server' => ['sometimes', 'uuid']]);
        $q = $this->scope($request);
        $acc = $request->input('filter.hosting_account');
        if (is_string($acc)) {
            $q->where('hosting_account_id', HostingAccount::query()->where('uuid', $acc)->value('id') ?? 0);
        }
        $srv = $request->input('filter.server');
        if (is_string($srv)) {
            $q->where('server_id', Server::query()->where('uuid', $srv)->value('id') ?? 0);
        }
        Listing::search($request, $q, ['websites.primary_domain']);

        return response()->json(Listing::page($request, $q->with(['account', 'server', 'settings']),
            ['created_at' => 'websites.created_at', 'primary_domain' => 'websites.primary_domain', 'status' => 'websites.status'],
            '-created_at', fn (Website $w): array => $this->present->website($w)));
    }

    public function store(Request $request): JsonResponse
    {
        HostingPackageController::rejectUnknown($request, ['hosting_account_uuid', 'primary_domain', 'type', 'document_root',
            'php_version', 'ssl_mode', 'proxy_target', 'docker_target']);
        $in = $request->validate([
            'hosting_account_uuid' => ['required', 'uuid'], 'primary_domain' => ['required', 'string', 'max:253'],
            'type' => ['required', 'in:php,static,proxy,docker'], 'document_root' => ['sometimes', 'string', 'max:255'],
            'php_version' => ['sometimes', 'nullable', 'string', 'regex:/^[5-9]\.[0-9]$/'], 'ssl_mode' => ['sometimes', 'in:none,acme'],
            'proxy_target' => ['sometimes', 'nullable', 'string', 'max:40'],
            'docker_target' => ['sometimes', 'nullable', 'array:compose_project_uuid,service'],
            'docker_target.compose_project_uuid' => ['required_with:docker_target', 'uuid'],
            'docker_target.service' => ['required_with:docker_target', 'string', 'regex:/^[a-z0-9][a-z0-9_.-]{0,62}$/'],
        ]);
        $a = $this->access->accounts($this->actor($request))->where('hosting_accounts.uuid', $in['hosting_account_uuid'])->first();
        if (! $a instanceof HostingAccount) {
            throw ApiProblem::field('hosting_account_uuid', 'Không tìm thấy tài khoản hosting trong phạm vi.');
        }
        [, $job] = $this->service->create($this->actor($request), $a, $in);

        return $this->accepted($request, $job);
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);

        return response()->json(['data' => $this->present->website($w)])->header('ETag', WebsiteService::etag($w));
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);
        $this->ifMatch($request, WebsiteService::etag($w));
        HostingPackageController::rejectUnknown($request, ['document_root', 'php_version', 'ssl_mode', 'waf_enabled']);
        $in = $request->validate(['document_root' => ['sometimes', 'string', 'max:255'],
            'php_version' => ['sometimes', 'nullable', 'string', 'regex:/^[5-9]\.[0-9]$/'],
            'ssl_mode' => ['sometimes', 'in:none,acme,custom'], 'waf_enabled' => ['sometimes', 'boolean']]);

        return $this->accepted($request, $this->service->update($this->actor($request), $w, $in));
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);

        return $this->accepted($request, $this->service->delete($this->actor($request), $w));
    }

    public function domains(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);
        $q = WebsiteDomain::query()->where('website_id', $w->id);
        Listing::search($request, $q, ['domains.name']);

        return response()->json(Listing::page($request, $q, ['name' => 'domains.name', 'created_at' => 'domains.created_at'], 'created_at',
            fn (WebsiteDomain $d): array => WebPresenter::domain($d, $w)));
    }

    public function addDomain(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);
        HostingPackageController::rejectUnknown($request, ['name', 'type']);
        $in = $request->validate(['name' => ['required', 'string', 'max:253'], 'type' => ['required', 'in:alias,redirect,subdomain']]);
        [, $job] = $this->service->addDomain($this->actor($request), $w, (string) $in['name'], (string) $in['type']);

        return $this->accepted($request, $job);
    }

    public function removeDomain(Request $request, string $id, string $domain): JsonResponse
    {
        $w = $this->find($request, $id);
        $d = Str::isUuid($domain) ? WebsiteDomain::query()->where('website_id', $w->id)->where('uuid', $domain)->first() : null;
        if (! $d instanceof WebsiteDomain) {
            throw new NotFoundHttpException;
        }

        return $this->accepted($request, $this->service->removeDomain($this->actor($request), $w, $d));
    }

    public function nginx(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);

        return response()->json(['data' => WebPresenter::nginx($w)])->header('ETag', WebsiteService::etag($w));
    }

    public function updateNginx(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);
        $this->ifMatch($request, WebsiteService::etag($w));
        HostingPackageController::rejectUnknown($request, ['client_max_body_size', 'http2', 'hsts', 'extra_headers', 'redirects']);
        $in = $request->validate([
            'client_max_body_size' => ['sometimes', 'string', self::SIZE], 'http2' => ['sometimes', 'boolean'], 'hsts' => ['sometimes', 'boolean'],
            'extra_headers' => ['sometimes', 'array'], 'extra_headers.*' => ['string', 'max:512', 'regex:/^[^;{}"\'\\\\$\x00-\x1f\x7f]*$/'],
            'redirects' => ['sometimes', 'array', 'max:100'], 'redirects.*' => ['array:from,to,code'],
            'redirects.*.from' => ['required', 'string', 'max:512', 'regex:#^/[A-Za-z0-9._~%/-]*$#'],
            'redirects.*.to' => ['required', 'string', 'max:1024',
                'regex:#^https?://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:[0-9]{1,5})?(/[A-Za-z0-9._~%/-]*)?$#'],
            'redirects.*.code' => ['required', 'in:301,302'],
        ]);
        if (isset($in['extra_headers']) && array_is_list($in['extra_headers']) && $in['extra_headers'] !== []) {
            throw ApiProblem::field('extra_headers', 'extra_headers phải là object tên → giá trị.');
        }

        return $this->accepted($request, $this->service->updateNginx($this->actor($request), $w, $in));
    }

    public function php(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);
        if ($w->type !== 'php') {
            throw new NotFoundHttpException;
        }

        return response()->json(['data' => WebPresenter::php($w)])->header('ETag', WebsiteService::etag($w));
    }

    public function updatePhp(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);
        $this->ifMatch($request, WebsiteService::etag($w));
        HostingPackageController::rejectUnknown($request, ['version', 'memory_limit', 'max_execution_time', 'upload_max_filesize',
            'pm_max_children', 'disable_functions']);
        $in = $request->validate([
            'version' => ['sometimes', 'string', 'regex:/^[5-9]\.[0-9]$/'], 'memory_limit' => ['sometimes', 'string', self::SIZE],
            'max_execution_time' => ['sometimes', 'integer', 'min:1', 'max:600'], 'upload_max_filesize' => ['sometimes', 'string', self::SIZE],
            'pm_max_children' => ['sometimes', 'integer', 'min:1', 'max:64'], 'disable_functions' => ['sometimes', 'array', 'max:100'],
            'disable_functions.*' => ['string', 'max:64', 'regex:/^[a-z_0-9]+$/'],
        ]);

        return $this->accepted($request, $this->service->updatePhp($this->actor($request), $w, $in));
    }

    public function logs(Request $request, string $id): JsonResponse
    {
        $w = $this->find($request, $id);
        $in = $request->validate(['kind' => ['required', 'in:access,error'], 'lines' => ['sometimes', 'integer', 'min:1', 'max:2000']]);
        $lines = $this->service->logs($this->actor($request), $w, (string) $in['kind'], (int) ($in['lines'] ?? 200));

        return response()->json(['data' => $lines])->header('ETag', '"log-'.substr(hash('sha256', implode("\n", $lines)), 0, 16).'"');
    }

    /** @return Builder<Website> */
    private function scope(Request $request): Builder
    {
        return Website::query()->whereIn('hosting_account_id', $this->access->accounts($this->actor($request))->select('hosting_accounts.id'));
    }

    private function find(Request $request, string $id): Website
    {
        $w = Str::isUuid($id) ? $this->scope($request)->with(['account', 'server', 'settings'])->where('websites.uuid', $id)->first() : null;
        if (! $w instanceof Website) {
            throw new NotFoundHttpException;
        }

        return $w;
    }

    private function ifMatch(Request $request, string $etag): void
    {
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== $etag) {
            throw new ApiProblem(412, 'precondition_failed', 'Website đã thay đổi', 'Tải lại rồi sửa lại.');
        }
    }

    private function accepted(Request $request, Job $job): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), $this->actor($request)->realm === Realm::PORTAL ? Realm::PORTAL : Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
