<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Audit\AuditLogger;
use App\Domain\Hosting\PackageLimits;
use App\Domain\Hosting\ProvisioningService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\HostingPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\AccountLifecycleEvent;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * /admin/hosting-accounts (Prompt 3.5): đọc theo phạm vi, mọi thay đổi qua ProvisioningService (job 202).
 * Purge (Phase 8) và chuyển server (Phase 9) trả 501 có mã riêng.
 */
final class HostingAccountController
{
    public function __construct(
        private readonly Access $access,
        private readonly HostingPresenter $present,
        private readonly ProvisioningService $provisioning,
        private readonly JobPresenter $jobs,
        private readonly AuditLogger $audit,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $request->validate(['filter.server' => ['sometimes', 'uuid'],
            'filter.lifecycle_state' => ['sometimes', 'in:pending,provisioning,active,suspended,migrating,terminated,purged,failed']]);
        $q = $this->access->accounts($this->actor($request));
        $server = $request->input('filter.server');
        if (is_string($server)) {
            $q->where('server_id', Server::query()->where('uuid', $server)->value('id') ?? 0);
        }
        $state = $request->input('filter.lifecycle_state');
        if (is_string($state)) {
            $q->where('lifecycle_state', $state);
        }
        Listing::search($request, $q, ['hosting_accounts.username']);

        return response()->json(Listing::page($request, $q,
            ['created_at' => 'hosting_accounts.created_at', 'username' => 'hosting_accounts.username',
                'lifecycle_state' => 'hosting_accounts.lifecycle_state'],
            '-created_at', fn (HostingAccount $a): array => $this->present->account($a)));
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $a = $this->find($request, $id);

        return response()->json(['data' => $this->present->account($a)])->header('ETag', HostingPresenter::accountEtag($a));
    }

    public function store(Request $request): JsonResponse
    {
        HostingPackageController::rejectUnknown($request, ['owner_user_uuid', 'package_uuid', 'server_uuid', 'username',
            'primary_domain', 'limits_override']);
        $in = $request->validate([
            'owner_user_uuid' => ['required', 'uuid'], 'package_uuid' => ['required', 'uuid'], 'server_uuid' => ['required', 'uuid'],
            'username' => ['required', 'string'], 'primary_domain' => ['sometimes', 'nullable', 'string', 'max:253'],
        ] + self::overrideRules());
        $actor = $this->actor($request);
        $owner = $this->access->users($actor)->where('uuid', $in['owner_user_uuid'])->first();
        if (! $owner instanceof User) {
            throw ApiProblem::field('owner_user_uuid', 'Không tìm thấy USER Portal trong phạm vi.');
        }
        $package = HostingPackage::query()->where('uuid', $in['package_uuid'])->first();
        if (! $package instanceof HostingPackage) {
            throw ApiProblem::field('package_uuid', 'Không tìm thấy gói.');
        }
        $server = $this->access->servers($actor)->where('uuid', $in['server_uuid'])->first();
        if (! $server instanceof Server) {
            throw ApiProblem::field('server_uuid', 'Không tìm thấy server trong phạm vi.');
        }
        [, $job] = $this->provisioning->create($actor, $owner, $package, $server, (string) $in['username'],
            self::override($in['limits_override'] ?? []));

        return $this->accepted($job);
    }

    public function update(Request $request, string $id): JsonResponse
    {
        $a = $this->find($request, $id);
        $ifMatch = $request->header('If-Match');
        if (is_string($ifMatch) && $ifMatch !== '' && $ifMatch !== HostingPresenter::accountEtag($a)) {
            throw new ApiProblem(412, 'precondition_failed', 'Account đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        HostingPackageController::rejectUnknown($request, ['owner_user_uuid', 'legal_hold', 'limits_override']);
        $in = $request->validate(['owner_user_uuid' => ['sometimes', 'uuid'], 'legal_hold' => ['sometimes', 'boolean']]
            + self::overrideRules());
        $actor = $this->actor($request);
        if (array_key_exists('legal_hold', $in) && ! $this->access->isSuperAdmin($actor)) {
            throw ApiProblem::forbidden('Chỉ SUPER_ADMIN đặt/bỏ legal hold.');
        }
        $this->provisioning->ensureIdle($a);
        DB::transaction(function () use ($a, $in, $actor): void {
            $changes = [];
            if (isset($in['owner_user_uuid'])) {
                $owner = $this->access->users($actor)->where('uuid', $in['owner_user_uuid'])->where('realm', Realm::PORTAL)->first();
                if (! $owner instanceof User) {
                    throw ApiProblem::field('owner_user_uuid', 'Không tìm thấy USER Portal trong phạm vi.');
                }
                if ($owner->id !== $a->owner_user_id) {
                    $changes['owner_user_id'] = ['from' => $a->owner_user_id, 'to' => $owner->id];
                    $a->owner_user_id = $owner->id;
                }
            }
            if (array_key_exists('legal_hold', $in) && $in['legal_hold'] !== $a->legal_hold) {
                $changes['legal_hold'] = ['from' => $a->legal_hold, 'to' => $in['legal_hold']];
                $a->legal_hold = (bool) $in['legal_hold'];
            }
            if ($changes !== []) {
                $a->save();
                $this->audit->record('hosting_account.update', $a, $changes, 'success', $a->server_id, null, $actor);
            }
            if (array_key_exists('limits_override', $in)) {
                $override = self::override($in['limits_override']);
                if ($override !== $a->limits_override) {
                    $this->provisioning->updateOverride($actor, $a, $override);
                }
            }
        });
        $a->refresh();

        return response()->json(['data' => $this->present->account($a)])->header('ETag', HostingPresenter::accountEtag($a));
    }

    public function features(Request $request, string $id): JsonResponse
    {
        return response()->json(['data' => $this->present->features($this->find($request, $id))]);
    }

    public function usage(Request $request, string $id): JsonResponse
    {
        $a = $this->find($request, $id);

        return response()->json(['data' => $this->present->account($a)['usage']]);
    }

    public function lifecycleEvents(Request $request, string $id): JsonResponse
    {
        $a = $this->find($request, $id);
        $q = AccountLifecycleEvent::query()->where('hosting_account_id', $a->id);

        return response()->json(Listing::page($request, $q, ['at' => 'account_lifecycle_events.at'], '-at',
            fn (AccountLifecycleEvent $e): array => HostingPresenter::event($e)));
    }

    public function suspend(Request $request, string $id): JsonResponse
    {
        $a = $this->find($request, $id);
        HostingPackageController::rejectUnknown($request, ['reason']);
        $in = $request->validate(['reason' => ['required', 'string', 'min:5', 'max:500']]);

        return $this->accepted($this->provisioning->suspend($this->actor($request), $a, trim((string) $in['reason'])));
    }

    public function unsuspend(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->provisioning->unsuspend($this->actor($request), $this->find($request, $id)));
    }

    public function terminate(Request $request, string $id): JsonResponse
    {
        $a = $this->find($request, $id);
        HostingPackageController::rejectUnknown($request, ['reason', 'confirm_username']);
        $in = $request->validate(['reason' => ['required', 'string', 'min:5', 'max:500'], 'confirm_username' => ['required', 'string']]);

        return $this->accepted($this->provisioning->terminate($this->actor($request), $a, trim((string) $in['reason']),
            (string) $in['confirm_username']));
    }

    public function changePackage(Request $request, string $id): JsonResponse
    {
        $a = $this->find($request, $id);
        HostingPackageController::rejectUnknown($request, ['package_uuid', 'version', 'reason']);
        $in = $request->validate(['package_uuid' => ['required', 'uuid'], 'version' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'reason' => ['sometimes', 'string', 'max:500']]);
        $p = HostingPackage::query()->where('uuid', $in['package_uuid'])->first();
        if (! $p instanceof HostingPackage) {
            throw ApiProblem::field('package_uuid', 'Không tìm thấy gói.');
        }

        return $this->accepted($this->provisioning->changePackage($this->actor($request), $a, $p,
            isset($in['version']) ? (int) $in['version'] : null, $in['reason'] ?? null));
    }

    /** migrate (Phase 9): chưa hiện thực — trả 501, không giả thành công. Purge: BackupAdminController (Phase 8). */
    public function notAvailable(Request $request, string $id): JsonResponse
    {
        $this->find($request, $id);

        throw new ApiProblem(501, 'migration_not_available', 'Chưa có ở phiên bản này', 'Chuyển account sang server khác hiện thực ở Phase 9.');
    }

    public function placement(Request $request): JsonResponse
    {
        $request->validate(['package' => ['required', 'uuid']]);
        $p = HostingPackage::query()->where('uuid', $request->query('package'))->first();
        if (! $p instanceof HostingPackage) {
            throw ApiProblem::field('package', 'Không tìm thấy gói.');
        }
        $limits = PackageLimits::of($this->provisioning->currentVersion($p));
        $rows = [];
        foreach ($this->access->servers($this->actor($request))->orderBy('name')->get() as $s) {
            $f = $s->observed_facts;
            $accounts = HostingAccount::query()->where('server_id', $s->id)->whereNotIn('lifecycle_state', ['purged'])->get();
            $reasons = [];
            $score = 100;
            if (! $s->accepting_new_accounts) {
                $score = 0;
                $reasons[] = 'Server đang tắt nhận account mới';
            }
            if ($s->status !== 'ready') {
                $score = min($score, 20);
                $reasons[] = "Trạng thái server: {$s->status}";
            }
            $ram = is_numeric($f['ram_mb'] ?? null) ? (int) $f['ram_mb'] : 0;
            if ($ram > 0) {
                $allocated = DB::table('hosting_package_versions')->whereIn('id', $accounts->pluck('package_version_id'))->get(['id', 'ram_mb'])
                    ->keyBy('id');
                $sum = $accounts->sum(fn (HostingAccount $a): int => (int) ($allocated[$a->package_version_id]->ram_mb ?? 0));
                $ratio = ($sum + (int) $limits['ram_mb']) / $ram;
                $reasons[] = sprintf('RAM đã cấp %d%% sau khi thêm', (int) round($ratio * 100));
                $score = min($score, max(0, (int) round(100 - max(0, $ratio - 1) * 100 - $ratio * 30)));
            }
            $reasons[] = $accounts->count().' account đang có';
            // D-92: server bị loại vẫn trả về kèm lý do; % cam kết = tổng hạn mức đĩa các account / dung lượng đĩa.
            $excluded = [];
            if (! $s->accepting_new_accounts) {
                $excluded[] = 'Đang tắt nhận account mới';
            }
            if ($s->status !== 'ready') {
                $excluded[] = "Trạng thái server: {$s->status}";
            }
            $disk = is_numeric($f['disk_mb'] ?? null) ? (int) $f['disk_mb'] : 0;
            $quota = (int) DB::table('hosting_package_versions')->whereIn('id', $accounts->pluck('package_version_id'))
                ->get(['id', 'disk_mb'])->keyBy('id')->pipe(fn ($v) => $accounts->sum(fn (HostingAccount $a): int => (int) ($v[$a->package_version_id]->disk_mb ?? 0)));
            $rows[] = ['server' => ['uuid' => $s->uuid, 'name' => $s->name], 'score' => max(0, min(100, $score)),
                'reasons' => $reasons, 'accepting_new' => $s->accepting_new_accounts,
                'eligible' => $excluded === [], 'excluded_reasons' => $excluded,
                'commit_pct' => $disk > 0 ? (int) round($quota * 100 / $disk) : 0];
        }
        usort($rows, fn (array $x, array $y): int => $y['score'] <=> $x['score']);

        return response()->json(['data' => $rows, 'meta' => ['next_cursor' => null, 'limit' => count($rows) ?: 1]]);
    }

    private function accepted(Job $job): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }

    private function find(Request $request, string $id): HostingAccount
    {
        $a = Str::isUuid($id) ? $this->access->accounts($this->actor($request))->where('hosting_accounts.uuid', $id)->first() : null;
        if (! $a instanceof HostingAccount) {
            throw new NotFoundHttpException;
        }

        return $a;
    }

    /** @return array<string, list<string>> */
    private static function overrideRules(): array
    {
        return ['limits_override' => ['sometimes', 'array:'.implode(',', PackageLimits::INT_KEYS)],
            'limits_override.*' => ['integer', 'min:0', 'max:2147483647']];
    }

    /**
     * @param  array<string, mixed>  $o
     * @return array<string, int>
     */
    private static function override(array $o): array
    {
        $out = array_map('intval', $o);
        ksort($out);

        return $out;
    }

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
