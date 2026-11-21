<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Dns\DnsService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\DnsPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\DnsProvider;
use App\Models\DnsRecord;
use App\Models\DnsZone;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** /admin/dns/* (Prompt 5.4, D-70): provider Cloudflare, zone, record. Chỉ realm admin. */
final class DnsController
{
    private const DOMAIN = 'regex:/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/';

    public function __construct(
        private readonly Access $access,
        private readonly DnsService $service,
        private readonly JobPresenter $jobs,
    ) {}

    public function providers(Request $request): JsonResponse
    {
        $q = DnsProvider::query();
        Listing::search($request, $q, ['dns_providers.name']);

        return response()->json(Listing::page($request, $q, ['name' => 'dns_providers.name', 'created_at' => 'dns_providers.created_at'],
            'name', fn (DnsProvider $p): array => DnsPresenter::provider($p)));
    }

    public function storeProvider(Request $request): JsonResponse
    {
        HostingPackageController::rejectUnknown($request, ['type', 'name', 'api_token']);
        $in = $request->validate(['type' => ['required', 'in:cloudflare'], 'name' => ['required', 'string', 'min:1', 'max:100'],
            'api_token' => ['required', 'string', 'min:20', 'max:200', 'regex:/^[A-Za-z0-9_-]+$/']]);

        return response()->json(['data' => DnsPresenter::provider($this->service->createProvider($this->actor($request),
            (string) $in['name'], (string) $in['api_token']))], 201);
    }

    public function destroyProvider(Request $request, string $id): Response
    {
        $p = Str::isUuid($id) ? DnsProvider::query()->where('uuid', $id)->first() : null;
        if (! $p instanceof DnsProvider) {
            throw new NotFoundHttpException;
        }
        $this->service->deleteProvider($this->actor($request), $p);

        return response()->noContent();
    }

    public function zones(Request $request): JsonResponse
    {
        $q = $this->service->zones($this->actor($request))->with(['provider', 'account']);
        Listing::search($request, $q, ['dns_zones.name']);

        return response()->json(Listing::page($request, $q, ['name' => 'dns_zones.name', 'created_at' => 'dns_zones.created_at'],
            'name', fn (DnsZone $z): array => DnsPresenter::zone($z)));
    }

    public function storeZone(Request $request): JsonResponse
    {
        HostingPackageController::rejectUnknown($request, ['provider_uuid', 'name', 'hosting_account_uuid']);
        $in = $request->validate(['provider_uuid' => ['required', 'uuid'], 'name' => ['required', 'string', self::DOMAIN],
            'hosting_account_uuid' => ['sometimes', 'nullable', 'uuid']]);
        $p = DnsProvider::query()->where('uuid', $in['provider_uuid'])->first();
        if (! $p instanceof DnsProvider) {
            throw ApiProblem::field('provider_uuid', 'Không tìm thấy provider.');
        }
        $z = $this->service->createZone($this->actor($request), $p, (string) $in['name'], $this->account($request, $in['hosting_account_uuid'] ?? null));

        return response()->json(['data' => DnsPresenter::zone($z->load(['provider', 'account']))], 201)
            ->header('ETag', DnsService::etag($z));
    }

    public function updateZone(Request $request, string $id): JsonResponse
    {
        $z = $this->zone($request, $id);
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== DnsService::etag($z)) {
            throw new ApiProblem(412, 'precondition_failed', 'Zone đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        HostingPackageController::rejectUnknown($request, ['hosting_account_uuid']);
        $in = $request->validate(['hosting_account_uuid' => ['present', 'nullable', 'uuid']]);
        $z = $this->service->updateZone($this->actor($request), $z, $this->account($request, $in['hosting_account_uuid']));

        return response()->json(['data' => DnsPresenter::zone($z->load(['provider', 'account']))])->header('ETag', DnsService::etag($z));
    }

    public function destroyZone(Request $request, string $id): Response
    {
        $this->service->deleteZone($this->actor($request), $this->zone($request, $id));

        return response()->noContent();
    }

    public function sync(Request $request, string $id): JsonResponse
    {
        $z = $this->service->sync($this->actor($request), $this->zone($request, $id));

        return response()->json(['data' => DnsPresenter::zone($z->load(['provider', 'account']))]);
    }

    public function records(Request $request, string $id): JsonResponse
    {
        $z = $this->zone($request, $id);
        $q = DnsRecord::query()->where('zone_id', $z->id);
        Listing::search($request, $q, ['dns_records.name', 'dns_records.content']);

        return response()->json(Listing::page($request, $q, ['name' => 'dns_records.name', 'type' => 'dns_records.type',
            'created_at' => 'dns_records.created_at'], 'name', fn (DnsRecord $r): array => DnsPresenter::record($r)));
    }

    public function storeRecord(Request $request, string $id): JsonResponse
    {
        $z = $this->zone($request, $id);

        return $this->accepted($this->service->createRecord($this->actor($request), $z, $this->recordInput($request, true)));
    }

    public function updateRecord(Request $request, string $id, string $record): JsonResponse
    {
        $z = $this->zone($request, $id);

        return $this->accepted($this->service->updateRecord($this->actor($request), $z, $this->record($z, $record),
            $this->recordInput($request, false)));
    }

    public function destroyRecord(Request $request, string $id, string $record): JsonResponse
    {
        $z = $this->zone($request, $id);

        return $this->accepted($this->service->deleteRecord($this->actor($request), $z, $this->record($z, $record)));
    }

    /** @return array<string, mixed> */
    private function recordInput(Request $request, bool $create): array
    {
        HostingPackageController::rejectUnknown($request, ['type', 'name', 'content', 'ttl', 'priority', 'proxied']);
        $req = $create ? 'required' : 'sometimes';

        return $request->validate([
            'type' => [$req, 'in:'.implode(',', DnsService::TYPES)],
            'name' => [$req, 'string', 'max:253', 'regex:/^(@|\*|[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?)*)$/'],
            'content' => [$req, 'string', 'max:2048'], 'ttl' => [$req, 'integer', 'min:60', 'max:86400'],
            'priority' => ['sometimes', 'integer', 'min:0', 'max:65535'], 'proxied' => ['sometimes', 'boolean'],
        ]);
    }

    private function zone(Request $request, string $id): DnsZone
    {
        $z = Str::isUuid($id) ? $this->service->zones($this->actor($request))->with(['provider', 'account'])->where('dns_zones.uuid', $id)->first() : null;
        if (! $z instanceof DnsZone) {
            throw new NotFoundHttpException;
        }

        return $z;
    }

    private function record(DnsZone $z, string $id): DnsRecord
    {
        $r = Str::isUuid($id) ? DnsRecord::query()->where('zone_id', $z->id)->where('uuid', $id)->first() : null;
        if (! $r instanceof DnsRecord) {
            throw new NotFoundHttpException;
        }

        return $r;
    }

    private function account(Request $request, mixed $uuid): ?HostingAccount
    {
        if ($uuid === null) {
            return null;
        }
        $a = $this->access->accounts($this->actor($request))->where('hosting_accounts.uuid', (string) $uuid)->first();
        if (! $a instanceof HostingAccount) {
            throw ApiProblem::field('hosting_account_uuid', 'Không tìm thấy tài khoản hosting trong phạm vi.');
        }

        return $a;
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
