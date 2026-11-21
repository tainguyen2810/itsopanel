<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Auth\Realm;
use App\Domain\Migration\MigrationService;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\BackupPresenter;
use App\Http\Presenters\HostingPresenter;
use App\Http\Presenters\JobPresenter;
use App\Http\Support\Listing;
use App\Models\AccountMigration;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Chuyển account giữa server (Prompt 9.6): bắt đầu/kiểm tra trước ở /hosting-accounts/{id}:migrate[-preflight],
 * theo dõi + cutover/hoàn tác/dọn nguồn ở /account-migrations. ADMIN chỉ thấy lượt chuyển mà cả hai server
 * đều trong phạm vi.
 */
final class AccountMigrationController
{
    public function __construct(private readonly Access $access, private readonly MigrationService $svc, private readonly JobPresenter $jobs) {}

    public function preflight(Request $request, string $id): JsonResponse
    {
        $a = $this->account($request, $id);
        $in = $request->validate(['target_server_uuid' => ['required', 'uuid']]);
        $res = $this->svc->preflight($this->actor($request), $a, $this->server($request, $in['target_server_uuid']));

        return response()->json(['data' => ['ok' => $res['ok'], 'target_server' => ['uuid' => $res['target_server']->uuid,
            'name' => $res['target_server']->name], 'checks' => $res['checks'], 'estimate' => $res['estimate']]]);
    }

    public function migrate(Request $request, string $id): JsonResponse
    {
        $a = $this->account($request, $id);
        $in = $request->validate(['target_server_uuid' => ['required', 'uuid'], 'keep_source_days' => ['sometimes', 'integer', 'min:1', 'max:30']]);
        $job = $this->svc->start($this->actor($request), $a, $this->server($request, $in['target_server_uuid']), (int) ($in['keep_source_days'] ?? 7));

        return $this->accepted($job);
    }

    public function index(Request $request): JsonResponse
    {
        $q = $this->scoped($request);
        Listing::search($request, $q, ['account_migrations.state']);

        return response()->json(Listing::page($request, $q, ['created_at' => 'account_migrations.created_at',
            'updated_at' => 'account_migrations.updated_at', 'state' => 'account_migrations.state'], '-created_at',
            fn (AccountMigration $m): array => self::present($m)));
    }

    public function show(Request $request, string $id): JsonResponse
    {
        $m = $this->find($request, $id);

        return response()->json(['data' => self::present($m)])->header('ETag', '"am-'.substr(hash('sha256', $m->uuid.'|'.$m->updated_at->format('U.u')), 0, 16).'"');
    }

    public function cutover(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->svc->cutover($this->actor($request), $this->find($request, $id)));
    }

    public function rollback(Request $request, string $id): JsonResponse
    {
        return $this->accepted($this->svc->rollback($this->actor($request), $this->find($request, $id)));
    }

    public function cleanup(Request $request, string $id): JsonResponse
    {
        $m = $this->find($request, $id);
        $in = $request->validate(['confirm_username' => ['required', 'string', 'max:32']]);

        return $this->accepted($this->svc->cleanup($this->actor($request), $m, $in['confirm_username'], true));
    }

    /** @return array<string, mixed> */
    public static function present(AccountMigration $m): array
    {
        $ref = fn (int $id): array => ($s = Server::withTrashed()->find($id)) instanceof Server ? ['uuid' => $s->uuid, 'name' => $s->name]
            : ['uuid' => '00000000-0000-4000-8000-000000000000', 'name' => '?'];
        $job = $m->job_id !== null ? Job::query()->find($m->job_id) : null;
        $dns = $m->dns;

        return ['uuid' => $m->uuid, 'hosting_account' => BackupPresenter::accountRef($m->hosting_account_id),
            'source_server' => $ref($m->source_server_id), 'target_server' => $ref($m->target_server_id), 'state' => $m->state,
            'bytes_synced' => $m->bytes_synced, 'downtime_sec' => $m->downtime_sec, 'downtime_estimate_sec' => $m->downtime_estimate_sec,
            'verification' => $m->verification,
            'dns' => $dns !== null ? ['mode' => (string) $dns['mode'], 'zone' => $dns['zone'] ?? null, 'records' => $dns['records']] : null,
            'job_uuid' => $job?->uuid, 'requested_by' => HostingPresenter::userRef(User::query()->find($m->requested_by_user_id)),
            'cutover_at' => $m->cutover_at?->toIso8601String(), 'cleanup_after' => $m->cleanup_after?->toIso8601String(),
            'error' => $m->error, 'created_at' => $m->created_at->toIso8601String(), 'updated_at' => $m->updated_at->toIso8601String()];
    }

    /** @return Builder<AccountMigration> */
    private function scoped(Request $request): Builder
    {
        $servers = $this->access->servers($this->actor($request))->pluck('servers.id')->all();

        return AccountMigration::query()->whereIn('source_server_id', $servers ?: [0])->whereIn('target_server_id', $servers ?: [0]);
    }

    private function find(Request $request, string $id): AccountMigration
    {
        $m = Str::isUuid($id) ? $this->scoped($request)->where('uuid', $id)->first() : null;
        if (! $m instanceof AccountMigration) {
            throw new NotFoundHttpException;
        }

        return $m;
    }

    private function account(Request $request, string $id): HostingAccount
    {
        $a = Str::isUuid($id) ? $this->access->accounts($this->actor($request))->where('hosting_accounts.uuid', $id)->first() : null;
        if (! $a instanceof HostingAccount) {
            throw new NotFoundHttpException;
        }

        return $a;
    }

    private function server(Request $request, string $uuid): Server
    {
        $s = Server::query()->where('uuid', $uuid)->first();
        if (! $s instanceof Server) {
            throw ApiProblem::field('target_server_uuid', 'Không có server này.');
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
