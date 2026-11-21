<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Domain\Backup\BackupService;
use App\Domain\Backup\DestinationService;
use App\Domain\Backup\PolicyService;
use App\Domain\Backup\PurgeService;
use App\Domain\Hosting\QuotaService;
use App\Exceptions\ApiProblem;
use App\Http\Middleware\RequireStepUp;
use App\Http\Presenters\BackupPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\BackupDestination;
use App\Models\BackupPolicy;
use App\Models\BackupRepository;
use App\Models\BackupSnapshot;
use App\Models\BackupVerification;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\PurgeRecord;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * /admin: đích, chính sách, repo, kiểm chứng, tổng quan 3-2-1-1-0, xóa/kiểm chứng snapshot, bộ khôi phục, purge (Prompt 8.4).
 * Đích/chính sách/bộ khôi phục/xóa snapshot/purge: backups.manage (SUPER_ADMIN). Repo/kiểm chứng theo phạm vi account.
 */
final class BackupAdminController
{
    public function __construct(private readonly Access $access, private readonly JobPresenter $jobs, private readonly BackupService $backups,
        private readonly DestinationService $destinations, private readonly PolicyService $policies, private readonly PurgeService $purges,
        private readonly QuotaService $quota, private readonly RequireStepUp $stepUp) {}

    private function actor(Request $request): User
    {
        /** @var User */
        return $request->user();
    }

    private function accepted(Job $job): JsonResponse
    {
        $data = $this->jobs->job($job->refresh(), 'admin');

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202)->header('Cache-Control', 'no-store');
    }

    /**
     * @template T of \Illuminate\Database\Eloquent\Model
     *
     * @param  class-string<T>  $model
     * @return T
     */
    private static function byUuid(string $model, string $id): mixed
    {
        $m = Str::isUuid($id) ? $model::query()->where('uuid', $id)->first() : null;
        if (! $m instanceof $model) {
            throw new NotFoundHttpException;
        }

        return $m;
    }

    /** @param  list<string>  $allowed */
    private static function only(Request $request, array $allowed): void
    {
        $extra = array_diff(array_keys($request->json()->all()), $allowed);
        if ($extra !== []) {
            throw ApiProblem::field((string) reset($extra), 'Trường không được hỗ trợ.');
        }
    }

    // ------------------------------------------------------------------ đích

    public function destinations(Request $request): JsonResponse
    {
        $q = BackupDestination::query();
        Listing::search($request, $q, ['backup_destinations.name']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'backup_destinations.created_at', 'name' => 'backup_destinations.name'],
            'created_at', fn (BackupDestination $d): array => BackupPresenter::destination($d)));
    }

    public function showDestination(string $id): JsonResponse
    {
        $d = self::byUuid(BackupDestination::class, $id);

        return response()->json(['data' => BackupPresenter::destination($d)])->header('ETag', BackupPresenter::etag($d));
    }

    public function storeDestination(Request $request): JsonResponse
    {
        self::only($request, ['name', 'type', 'append_only', 'immutable_days', 'config', 'credentials']);
        $in = $request->validate(['name' => ['required', 'string', 'min:1', 'max:120'], 'type' => ['required', 'in:local,sftp,s3,rest'],
            'append_only' => ['sometimes', 'boolean'], 'immutable_days' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:3650'],
            'config' => ['present', 'array'], 'credentials' => ['sometimes', 'array']]);
        $d = $this->destinations->create($this->actor($request), $in);

        return response()->json(['data' => BackupPresenter::destination($d)], 201);
    }

    public function updateDestination(Request $request, string $id): JsonResponse
    {
        $d = self::byUuid(BackupDestination::class, $id);
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== BackupPresenter::etag($d)) {
            throw new ApiProblem(412, 'precondition_failed', 'Tài nguyên đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        self::only($request, ['name', 'type', 'append_only', 'immutable_days', 'config', 'credentials']);
        $in = $request->validate(['name' => ['sometimes', 'string', 'min:1', 'max:120'], 'type' => ['sometimes', 'in:local,sftp,s3,rest'],
            'append_only' => ['sometimes', 'boolean'], 'immutable_days' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:3650'],
            'config' => ['sometimes', 'array'], 'credentials' => ['sometimes', 'array']]);

        return response()->json(['data' => BackupPresenter::destination($this->destinations->update($this->actor($request), $d, $in))]);
    }

    public function testDestination(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->destinations->test($this->actor($request), self::byUuid(BackupDestination::class, $id)));
    }

    /** Lần đầu (chưa xác nhận) không cần step-up; xem lại sau khi đã xác nhận thì cần step-up (ADR 0029 §6). */
    public function recoveryKit(Request $request, string $id): JsonResponse
    {
        $d = self::byUuid(BackupDestination::class, $id);
        if ($d->recovery_kit_acknowledged_at !== null) {
            $this->stepUp->handle($request, fn () => response()->noContent());
        }

        return response()->json(['data' => $this->destinations->recoveryKit($this->actor($request), $d)])->header('Cache-Control', 'no-store');
    }

    public function acknowledgeKit(Request $request, string $id): Response
    {
        $this->destinations->acknowledge($this->actor($request), self::byUuid(BackupDestination::class, $id));

        return response()->noContent();
    }

    // ------------------------------------------------------------------ chính sách

    public function policies(Request $request): JsonResponse
    {
        $q = BackupPolicy::query();
        Listing::search($request, $q, ['backup_policies.name']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'backup_policies.created_at', 'name' => 'backup_policies.name',
            'next_run_at' => 'backup_policies.next_run_at'], 'created_at', fn (BackupPolicy $p): array => BackupPresenter::policy($p)));
    }

    public function showPolicy(string $id): JsonResponse
    {
        $p = self::byUuid(BackupPolicy::class, $id);

        return response()->json(['data' => BackupPresenter::policy($p)])->header('ETag', BackupPresenter::etag($p));
    }

    /** @return array<string, list<string>> */
    private static function policyRules(bool $create): array
    {
        $req = $create ? 'required' : 'sometimes';

        return ['name' => [$req, 'string', 'min:1', 'max:120'], 'scope_type' => [$req, 'in:'.implode(',', PolicyService::SCOPES)],
            'scope_uuid' => ['sometimes', 'nullable', 'uuid'], 'contents' => ['sometimes', 'array'], 'contents.*' => ['string', 'in:files,databases,config'],
            'excludes' => ['sometimes', 'array', 'max:50'], 'excludes.*' => ['string', 'max:200'], 'schedule' => [$req, 'string', 'max:100'],
            'destination_uuids' => [$req, 'array', 'min:1', 'max:10'], 'destination_uuids.*' => ['uuid'], 'retention' => ['sometimes', 'array'],
            'enabled' => ['sometimes', 'boolean']];
    }

    public function storePolicy(Request $request): JsonResponse
    {
        self::only($request, array_keys(array_filter(self::policyRules(true), fn ($k) => ! str_contains($k, '*'), ARRAY_FILTER_USE_KEY)));
        $request->validate(self::policyRules(true));
        $p = $this->policies->create($this->actor($request), $request->json()->all());

        return response()->json(['data' => BackupPresenter::policy($p)], 201);
    }

    public function updatePolicy(Request $request, string $id): JsonResponse
    {
        $p = self::byUuid(BackupPolicy::class, $id);
        $m = $request->header('If-Match');
        if (is_string($m) && $m !== '' && $m !== BackupPresenter::etag($p)) {
            throw new ApiProblem(412, 'precondition_failed', 'Tài nguyên đã thay đổi', 'Tải lại rồi sửa lại.');
        }
        self::only($request, array_keys(array_filter(self::policyRules(false), fn ($k) => ! str_contains($k, '*'), ARRAY_FILTER_USE_KEY)));
        $request->validate(self::policyRules(false));

        return response()->json(['data' => BackupPresenter::policy($this->policies->update($this->actor($request), $p, $request->json()->all()))]);
    }

    public function destroyPolicy(Request $request, string $id): Response
    {
        $this->policies->delete($this->actor($request), self::byUuid(BackupPolicy::class, $id));

        return response()->noContent();
    }

    public function runPolicy(Request $request, string $id): JsonResponse
    {
        $jobs = $this->backups->runPolicy(self::byUuid(BackupPolicy::class, $id), $this->actor($request));
        if ($jobs === []) {
            throw new ApiProblem(409, 'precondition_failed', 'Không có gì để chạy', 'Phạm vi trống, account đang bận hoặc bị tạm dừng do quota.');
        }

        return $this->accepted($jobs[0]);
    }

    // ------------------------------------------------------------------ repo / kiểm chứng / tổng quan

    /** @param Builder<BackupRepository>|Builder<BackupVerification> $q */
    private function scope(Request $request, Builder $q, string $table): void
    {
        $actor = $this->actor($request);
        $accounts = $this->access->accounts($actor)->select('hosting_accounts.id');
        if ($this->access->can($actor, 'backups.manage')) {
            $q->where(fn (Builder $w) => $w->whereIn("$table.hosting_account_id", $accounts)->orWhereNull("$table.hosting_account_id"));
        } else {
            $q->whereIn("$table.hosting_account_id", $accounts);
        }
        $request->validate(['filter.hosting_account' => ['sometimes', 'uuid'], 'filter.destination' => ['sometimes', 'uuid']]);
        if (is_string($a = $request->input('filter.hosting_account'))) {
            $q->where("$table.hosting_account_id", HostingAccount::query()->where('uuid', $a)->value('id') ?? 0);
        }
        if (is_string($d = $request->input('filter.destination'))) {
            $q->where("$table.destination_id", BackupDestination::query()->where('uuid', $d)->value('id') ?? 0);
        }
    }

    public function repositories(Request $request): JsonResponse
    {
        $q = BackupRepository::query();
        $this->scope($request, $q, 'backup_repositories');
        Listing::search($request, $q, ['backup_repositories.path']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'backup_repositories.created_at', 'size_mb' => 'backup_repositories.size_bytes',
            'last_snapshot_at' => 'backup_repositories.last_snapshot_at'], '-created_at', fn (BackupRepository $r): array => BackupPresenter::repository($r)));
    }

    public function verifications(Request $request): JsonResponse
    {
        $q = BackupVerification::query();
        $this->scope($request, $q, 'backup_verifications');

        return response()->json(Listing::page($request, $q, ['started_at' => 'backup_verifications.started_at'], '-started_at',
            fn (BackupVerification $v): array => BackupPresenter::verification($v)));
    }

    public function overview(): JsonResponse
    {
        return response()->json(['data' => BackupPresenter::overview($this->backups, $this->quota)]);
    }

    // ------------------------------------------------------------------ snapshot (admin)

    private function scopedSnapshot(Request $request, string $id): BackupSnapshot
    {
        $s = self::byUuid(BackupSnapshot::class, $id);
        $actor = $this->actor($request);
        $inScope = $s->hosting_account_id === null ? $this->access->can($actor, 'backups.manage')
            : $this->access->accounts($actor)->where('hosting_accounts.id', $s->hosting_account_id)->exists();
        if (! $inScope) {
            throw new NotFoundHttpException;
        }

        return $s;
    }

    public function verifySnapshot(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->backups->verify($this->actor($request), $this->scopedSnapshot($request, $id)));
    }

    public function destroySnapshot(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->backups->deleteSnapshot($this->actor($request), self::byUuid(BackupSnapshot::class, $id)));
    }

    // ------------------------------------------------------------------ purge (D-46)

    private function purgeAccount(Request $request, string $id): HostingAccount
    {
        $a = Str::isUuid($id) ? $this->access->accounts($this->actor($request))->where('hosting_accounts.uuid', $id)->first() : null;
        if (! $a instanceof HostingAccount) {
            throw new NotFoundHttpException;
        }

        return $a;
    }

    public function schedulePurge(Request $request, string $id): JsonResponse
    {
        $a = $this->purgeAccount($request, $id);
        self::only($request, ['final_backup', 'note']);
        $in = $request->validate(['final_backup' => ['sometimes', 'boolean'], 'note' => ['sometimes', 'nullable', 'string', 'max:500']]);

        return $this->accepted($this->purges->schedule($this->actor($request), $a, (bool) ($in['final_backup'] ?? true), $in['note'] ?? null));
    }

    public function confirmPurge(Request $request, string $id): JsonResponse
    {
        $a = $this->purgeAccount($request, $id);
        self::only($request, ['purge_uuid', 'confirm_username']);
        $in = $request->validate(['purge_uuid' => ['required', 'uuid'], 'confirm_username' => ['required', 'string', 'max:32']]);

        return $this->accepted($this->purges->confirm($this->actor($request), $a, $in['purge_uuid'], $in['confirm_username']));
    }

    public function purgeRecords(Request $request): JsonResponse
    {
        $q = PurgeRecord::query();

        return response()->json(Listing::page($request, $q, ['created_at' => 'purge_records.created_at', 'scheduled_for' => 'purge_records.scheduled_for'],
            '-created_at', fn (PurgeRecord $p): array => BackupPresenter::purge($p)));
    }
}
