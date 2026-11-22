<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\WordPress\WordPressService;
use App\Exceptions\ApiProblem;
use App\Http\Controllers\Api\V1\Admin\HostingPackageController;
use App\Http\Presenters\JobPresenter;
use App\Http\Presenters\WordPressPresenter;
use App\Http\Support\Listing;
use App\Models\Job;
use App\Models\User;
use App\Models\Website;
use App\Models\WordPressSite;
use App\Models\WordPressUpdate;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * /admin/wordpress/* và /portal/wordpress/* (Prompt 10.6, D-99). Phạm vi theo Access::accounts (USER: chỉ account mình);
 * ngoài phạm vi → 404. Mọi thao tác trên site đi qua WordPressService → job agent (wp.*).
 */
final class WordPressController
{
    private const SLUG = 'regex:/^[a-z0-9][a-z0-9_-]{0,99}$/';

    public function __construct(
        private readonly Access $access,
        private readonly WordPressService $service,
        private readonly JobPresenter $jobs,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $q = $this->service->scope($this->actor($request))
            ->join('websites', 'websites.id', '=', 'wordpress_sites.website_id')->whereNull('websites.deleted_at')
            ->select('wordpress_sites.*');
        Listing::search($request, $q, ['websites.primary_domain']);

        return response()->json(Listing::page($request, $q->with(['website', 'account']),
            ['created_at' => 'wordpress_sites.created_at', 'primary_domain' => 'websites.primary_domain', 'updated_at' => 'wordpress_sites.updated_at'],
            'primary_domain', fn (WordPressSite $wp): array => WordPressPresenter::site($wp)));
    }

    public function store(Request $request): JsonResponse
    {
        HostingPackageController::rejectUnknown($request, ['website_uuid', 'title', 'admin_username', 'admin_email', 'locale']);
        $in = $request->validate([
            'website_uuid' => ['required', 'uuid'], 'title' => ['required', 'string', 'max:120'],
            'admin_username' => ['required', 'string', 'regex:/^[a-z][a-z0-9_]{2,30}$/', 'not_in:admin,administrator'],
            'admin_email' => ['required', 'email', 'max:254'], 'locale' => ['required', 'in:vi,en_US'],
        ]);
        $w = Website::query()->where('uuid', $in['website_uuid'])
            ->whereIn('hosting_account_id', $this->access->accounts($this->actor($request))->select('hosting_accounts.id'))->first();
        if (! $w instanceof Website) {
            throw ApiProblem::field('website_uuid', 'Không tìm thấy website trong phạm vi.');
        }
        [, $job, $password] = $this->service->install($this->actor($request), $w, $in);

        return $this->accepted($request, $job, $password);
    }

    public function scan(Request $request): JsonResponse
    {
        return $this->accepted($request, $this->service->scan($this->actor($request)));
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $wp = $this->service->find($this->actor($request), $id);
        $this->service->refresh($wp);
        $wp->refresh();

        return response()->json(['data' => WordPressPresenter::detail($wp)])->header('ETag', self::etag($wp));
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $wp = $this->service->find($this->actor($request), $id);
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== self::etag($wp)) {
            throw new ApiProblem(412, 'precondition_failed', 'Tài nguyên đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        HostingPackageController::rejectUnknown($request, ['auto_update', 'update_window']);
        $in = $request->validate(['auto_update' => ['sometimes', 'in:off,minor,all'],
            'update_window' => ['sometimes', 'string', 'regex:/^([01][0-9]|2[0-3]):00-([01][0-9]|2[0-3]):00$/']]);
        $wp = $this->service->settings($this->actor($request), $wp, $in);

        return response()->json(['data' => WordPressPresenter::site($wp)])->header('ETag', self::etag($wp));
    }

    public function updates(Request $request, string $id): JsonResponse
    {
        $wp = $this->service->find($this->actor($request), $id);
        $q = WordPressUpdate::query()->where('wordpress_site_id', $wp->id);

        return response()->json(Listing::page($request, $q, ['created_at' => 'wordpress_updates.created_at'], '-created_at',
            fn (WordPressUpdate $u): array => WordPressPresenter::update($u, $wp->uuid)));
    }

    public function runUpdate(Request $request, string $id): JsonResponse
    {
        $wp = $this->service->find($this->actor($request), $id);
        HostingPackageController::rejectUnknown($request, ['core', 'plugins', 'themes']);
        $in = $request->validate(['core' => ['sometimes', 'boolean'],
            'plugins' => ['sometimes', 'array', 'max:200'], 'plugins.*' => ['string', self::SLUG],
            'themes' => ['sometimes', 'array', 'max:50'], 'themes.*' => ['string', self::SLUG]]);
        if ($in === []) {
            // Body rỗng = mọi thành phần đang có bản mới (theo cache wp.info), như lịch tự cập nhật "all".
            $in = WordPressService::outdated($wp) ?? throw new ApiProblem(409, 'conflict', 'Không có gì để cập nhật',
                'Core, plugin và theme đều đang ở bản mới nhất.');
        }

        return $this->accepted($request, $this->service->update($this->actor($request), $wp, $in));
    }

    public function cloneStaging(Request $request, string $id): JsonResponse
    {
        $wp = $this->service->find($this->actor($request), $id);
        HostingPackageController::rejectUnknown($request, ['subdomain', 'basic_auth', 'noindex']);
        $in = $request->validate(['subdomain' => ['required', 'string', 'regex:/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/'],
            'basic_auth' => ['sometimes', 'boolean'], 'noindex' => ['sometimes', 'boolean']]);

        return $this->accepted($request, $this->service->cloneStaging($this->actor($request), $wp, $in));
    }

    public function harden(Request $request, string $id): JsonResponse
    {
        $wp = $this->service->find($this->actor($request), $id);
        HostingPackageController::rejectUnknown($request, ['items', 'enabled']);
        $in = $request->validate(['items' => ['required', 'array', 'min:1'], 'items.*' => ['string', 'in:'.implode(',', WordPressService::HARDENING)],
            'enabled' => ['required', 'boolean']]);

        return $this->accepted($request, $this->service->harden($this->actor($request), $wp,
            array_values(array_unique(array_map('strval', $in['items']))), (bool) $in['enabled']));
    }

    public function adminPassword(Request $request, string $id): JsonResponse
    {
        $wp = $this->service->find($this->actor($request), $id);
        HostingPackageController::rejectUnknown($request, ['password']);
        $in = $request->validate(['password' => ['required', 'string', 'min:12', 'max:128', 'regex:/^[A-Za-z0-9._~!@#%^*+=:,-]+$/']]);

        return $this->accepted($request, $this->service->adminPassword($this->actor($request), $wp, (string) $in['password']));
    }

    public function maintenance(Request $request, string $id): JsonResponse
    {
        $wp = $this->service->find($this->actor($request), $id);
        HostingPackageController::rejectUnknown($request, ['enabled']);
        $in = $request->validate(['enabled' => ['required', 'boolean']]);

        return $this->accepted($request, $this->service->maintenance($this->actor($request), $wp, (bool) $in['enabled']));
    }

    private static function etag(WordPressSite $wp): string
    {
        return '"wp-'.substr(hash('sha256', $wp->uuid.'|'.$wp->auto_update.'|'.$wp->update_window.'|'.$wp->updated_at->format('U.u')), 0, 16).'"';
    }

    private function accepted(Request $request, Job $job, ?string $secret = null): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), $this->actor($request)->realm === Realm::PORTAL ? Realm::PORTAL : Realm::ADMIN);
        $body = ['job' => $data, 'resource' => $data['resource']];
        if ($secret !== null) {
            $body['secret'] = $secret;
        }

        return response()->json($body, 202)->header('Cache-Control', 'no-store');
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
