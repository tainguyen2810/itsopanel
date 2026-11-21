<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Shared;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Web\CertificateService;
use App\Http\Controllers\Api\V1\Admin\HostingPackageController;
use App\Http\Presenters\JobPresenter;
use App\Http\Presenters\WebPresenter;
use App\Http\Support\Listing;
use App\Models\Certificate;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\User;
use App\Models\Website;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * /admin|portal/certificates và /websites/{id}/certificates (Prompt 5.4). Phạm vi theo website của Access::accounts;
 * ngoài phạm vi → 404. Khóa riêng tải lên không bao giờ trả ra.
 */
final class CertificateController
{
    public function __construct(
        private readonly Access $access,
        private readonly CertificateService $service,
        private readonly JobPresenter $jobs,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $request->validate(['filter.hosting_account' => ['sometimes', 'uuid']]);
        $q = $this->scope($request)->with('website');
        $acc = $request->input('filter.hosting_account');
        if (is_string($acc)) {
            $q->whereIn('website_id', Website::query()->where('hosting_account_id',
                HostingAccount::query()->where('uuid', $acc)->value('id') ?? 0)->select('id'));
        }
        $q->where('status', '!=', 'deleting');
        Listing::search($request, $q, ['certificates.issuer']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'certificates.created_at',
            'not_after' => 'certificates.not_after'], 'not_after', fn (Certificate $c): array => WebPresenter::certificate($c)));
    }

    public function store(Request $request, string $id): JsonResponse
    {
        $w = Str::isUuid($id) ? Website::query()->whereIn('hosting_account_id', $this->accounts($request))->where('uuid', $id)->first() : null;
        if (! $w instanceof Website) {
            throw new NotFoundHttpException;
        }
        HostingPackageController::rejectUnknown($request, ['source', 'domains', 'certificate_pem', 'private_key_pem']);
        $in = $request->validate([
            'source' => ['required', 'in:acme,upload'], 'domains' => ['required', 'array', 'min:1', 'max:100'],
            'domains.*' => ['string', 'max:253'],
            'certificate_pem' => ['nullable', 'string', 'max:65536', 'required_if:source,upload'],
            'private_key_pem' => ['nullable', 'string', 'max:16384', 'required_if:source,upload'],
        ]);
        [, $job] = $this->service->request($this->actor($request), $w, (string) $in['source'],
            array_values(array_map('strval', $in['domains'])), $in['certificate_pem'] ?? null, $in['private_key_pem'] ?? null);

        return $this->accepted($request, $job);
    }

    public function renew(Request $request, string $id): JsonResponse
    {
        return $this->accepted($request, $this->service->renew($this->actor($request), $this->find($request, $id)));
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        return $this->accepted($request, $this->service->delete($this->actor($request), $this->find($request, $id)));
    }

    /** @return Builder<Certificate> */
    private function scope(Request $request): Builder
    {
        return Certificate::query()->whereIn('website_id',
            Website::query()->whereIn('hosting_account_id', $this->accounts($request))->select('id'));
    }

    /** @return Builder<HostingAccount> */
    private function accounts(Request $request): Builder
    {
        return $this->access->accounts($this->actor($request))->select('hosting_accounts.id');
    }

    private function find(Request $request, string $id): Certificate
    {
        $c = Str::isUuid($id) ? $this->scope($request)->where('certificates.uuid', $id)->first() : null;
        if (! $c instanceof Certificate) {
            throw new NotFoundHttpException;
        }

        return $c;
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
