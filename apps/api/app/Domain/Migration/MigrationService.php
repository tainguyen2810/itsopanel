<?php

declare(strict_types=1);

namespace App\Domain\Migration;

use App\Auth\Access;
use App\Domain\Audit\AuditLogger;
use App\Domain\Backup\BackupService;
use App\Domain\Backup\BackupSpec;
use App\Domain\Data\DatabaseService;
use App\Domain\Data\DataSpec;
use App\Domain\Hosting\ProvisioningService;
use App\Domain\Hosting\QuotaService;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Jobs\Secrets;
use App\Domain\Notifications\Notifier;
use App\Domain\Web\WebsiteSpec;
use App\Exceptions\ApiProblem;
use App\Http\Presenters\ServerPresenter;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\AccountMigration;
use App\Models\Agent;
use App\Models\BackupRepository;
use App\Models\CronJob;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\DnsRecord;
use App\Models\DnsZone;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\Server;
use App\Models\SftpAccount;
use App\Models\User;
use App\Models\Website;
use App\Models\WebsiteDomain;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Điều phối chuyển account giữa server (Prompt 9.6, D-93, ADR 0038). Mỗi chặng là một job trên ĐÚNG một server;
 * MigrationJobHandler nối chặng sau khi chặng trước xong (op_id theo job → idempotent khi chạy lại):
 *
 *   hosting_account.migrate (nguồn: backup files + DB) → migration.sync (đích: preflight, account.ensure, DB, site,
 *   restore, cron, verify) → verifying. Cutover: migration.cutover (nguồn: khóa + backup lượt cuối) →
 *   migration.cutover_target (đích: restore lượt cuối, verify, mở, http.check, DNS) → holding (account đổi server).
 *   Rollback: migration.rollback (đích khóa, DNS về) → migration.rollback_source (nguồn mở). Dọn: migration.cleanup
 *   (nguồn: account.remove reason=migrated) → completed.
 *
 * Account ở `migrating` suốt lúc đồng bộ/cutover: Portal thấy "đang chuyển", mọi thao tác ghi bị chặn (409).
 */
final class MigrationService
{
    public const TYPES = ['hosting_account.migrate', 'migration.sync', 'migration.cutover', 'migration.cutover_target',
        'migration.rollback', 'migration.rollback_source', 'migration.cleanup'];

    private const ACTIVE_JOB = ['queued', 'running', 'cancel_requested', 'waiting_agent'];

    public function __construct(
        private readonly Access $access,
        private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit,
        private readonly AgentClient $agent,
        private readonly BackupService $backups,
        private readonly QuotaService $quota,
        private readonly DatabaseService $databases,
        private readonly Notifier $notifier,
    ) {}

    // ------------------------------------------------------------------ preflight

    /**
     * Kiểm tra trước (không đổi gì): phía panel (quyền, trạng thái, kết nối, vai trò, UID) + op migrate.preflight ở đích.
     *
     * @return array{ok: bool, target_server: Server, checks: list<array{key: string, level: string, message: string}>, estimate: array{bytes: int, downtime_sec: int}, repo: BackupRepository|null}
     */
    public function preflight(User $actor, HostingAccount $a, Server $target): array
    {
        $checks = [];
        $add = function (string $key, string $level, string $msg) use (&$checks): void {
            $checks[] = ['key' => $key, 'level' => $level, 'message' => mb_substr($msg, 0, 500)];
        };
        $source = Server::query()->findOrFail($a->server_id);
        if ($target->id === $source->id) {
            throw ApiProblem::field('target_server_uuid', 'Server đích phải khác server hiện tại của account.');
        }
        if (! $this->access->servers($actor)->whereKey($target->id)->exists()) {
            throw ApiProblem::field('target_server_uuid', 'Không có quyền trên server đích.');
        }
        if (AccountMigration::query()->where('hosting_account_id', $a->id)->whereIn('state', AccountMigration::OPEN)->exists()) {
            $add('migration', 'block', 'Account đang có một lượt chuyển chưa kết thúc.');
        }
        if ($a->lifecycle_state !== 'active') {
            $add('account', 'block', "Account đang {$a->lifecycle_state}: chỉ chuyển account đang hoạt động.");
        }
        $agent = Agent::query()->where('server_id', $target->id)->first();
        $conn = $agent instanceof Agent ? ServerPresenter::connection($agent) : 'pending';
        $add('connection', $conn === 'online' ? 'ok' : 'block', $conn === 'online'
            ? "{$target->name} đang kết nối".($agent?->transport === 'mtls' ? ' (mTLS qua relay)' : '')
            : "{$target->name} không kết nối (trạng thái $conn).");
        if (! in_array('web', $target->role_tags, true)) {
            $add('role', 'block', "{$target->name} không có vai trò web.");
        }
        if (! $target->accepting_new_accounts) {
            $add('accepting', 'warn', "{$target->name} đang tắt nhận account mới.");
        }
        $uidTaken = DB::table('uid_allocations')->where('server_id', $target->id)->where('uid', $a->uid)->whereNull('released_at')
            ->where(fn ($q) => $q->whereNull('hosting_account_id')->orWhere('hosting_account_id', '<>', $a->id))->exists()
            || HostingAccount::query()->where('server_id', $target->id)->where(fn ($q) => $q->where('uid', $a->uid)->orWhere('username', $a->username))->exists();
        if ($uidTaken) {
            $add('uid', 'block', "UID {$a->uid} hoặc username {$a->username} đã dùng trên {$target->name}.");
        }
        $repo = $this->repoFor($a, $source);
        if (! $repo instanceof BackupRepository) {
            $add('repo', 'block', 'Chưa có đích backup đang bật: dữ liệu chuyển qua repo backup của account (ADR 0038).');
        } elseif ($repo->destination->type === 'local') {
            $add('repo_local', 'warn', 'Đích backup local nằm trên server nguồn: server đích chỉ đọc được nếu dùng chung thư mục; nên dùng SFTP/S3.');
        }

        $sites = Website::query()->where('hosting_account_id', $a->id)->whereNotIn('status', ['deleting', 'failed', 'pending'])->orderBy('id')->get();
        $dbs = Database::query()->where('hosting_account_id', $a->id)->where('status', 'ready')->orderBy('name')->get();
        $bytes = max(0, (int) $this->quota->usage($a)['disk_mb']['used']) * 1048576;
        $bytes = max($bytes, (int) Database::query()->where('hosting_account_id', $a->id)->sum('size_mb') * 1048576);
        // Lượt cuối chỉ là phần chênh: ước 30 giây cố định + 1 giây mỗi 50 MB (tối thiểu 30 giây).
        $estimate = ['bytes' => $bytes, 'downtime_sec' => 30 + intdiv($bytes, 50 * 1048576)];

        if ($conn === 'online' && $repo instanceof BackupRepository) {
            $params = ['account' => DataSpec::acct($a), 'migration_uuid' => (string) Str::uuid(), 'repo' => BackupSpec::repo($repo),
                'need_bytes' => $bytes, 'php_versions' => array_values(array_unique(array_filter($sites->pluck('php_version')->all()))),
                'databases' => $dbs->map(fn (Database $d): array => ['engine' => DataSpec::engine($d->engine), 'name' => $d->name])->values()->all(),
                'sites' => $sites->pluck('primary_domain')->values()->all()];
            try {
                $res = $this->agent->forServer($target->id)->call('migrate.preflight', app(Secrets::class)->resolve($params));
                if ($res->ok && is_array($res->data['checks'] ?? null)) {
                    foreach ($res->data['checks'] as $c) {
                        $add((string) $c['key'], (string) $c['level'], (string) $c['message']);
                    }
                } else {
                    $add('agent', 'block', 'migrate.preflight ở đích lỗi: '.($res->error['message'] ?? 'không rõ'));
                }
            } catch (AgentUnavailable $e) {
                $add('agent', 'block', 'Không gọi được agent đích: '.mb_substr($e->getMessage(), 0, 200));
            }
        }
        $ok = collect($checks)->every(fn (array $c): bool => $c['level'] !== 'block');

        return ['ok' => $ok, 'target_server' => $target, 'checks' => $checks, 'estimate' => $estimate, 'repo' => $repo];
    }

    private function repoFor(HostingAccount $a, Server $source): ?BackupRepository
    {
        $dests = $this->backups->destinationsFor($a);
        $d = $dests->first(fn ($x) => $x->type !== 'local') ?? $dests->first();

        return $d !== null ? $this->backups->repository($d, $source, $a) : null;
    }

    // ------------------------------------------------------------------ bắt đầu

    public function start(User $actor, HostingAccount $a, Server $target, int $keepDays, ?string $idempotencyKey = null): Job
    {
        $pre = $this->preflight($actor, $a, $target);
        if (! $pre['ok']) {
            $blocks = collect($pre['checks'])->where('level', 'block')->pluck('message')->implode(' ');
            throw new ApiProblem(409, 'precondition_failed', 'Kiểm tra trước không đạt', mb_substr($blocks, 0, 1000));
        }
        /** @var BackupRepository $repo */
        $repo = $pre['repo'];

        return DB::transaction(function () use ($actor, $a, $target, $keepDays, $pre, $repo, $idempotencyKey): Job {
            /** @var HostingAccount $acc */
            $acc = HostingAccount::query()->lockForUpdate()->findOrFail($a->id);
            if ($acc->lifecycle_state !== 'active') {
                throw new ApiProblem(409, 'invalid_state_transition', 'Account không hoạt động', "Account đang {$acc->lifecycle_state}.");
            }
            $m = AccountMigration::query()->create(['hosting_account_id' => $acc->id, 'source_server_id' => $acc->server_id,
                'target_server_id' => $target->id, 'state' => 'syncing', 'keep_source_days' => $keepDays,
                'preflight' => ['checks' => $pre['checks'], 'estimate' => $pre['estimate'], 'repo_uuid' => $repo->uuid],
                'dns' => $this->dnsPlan($acc, $target), 'downtime_estimate_sec' => $pre['estimate']['downtime_sec'],
                'requested_by_user_id' => $actor->id]);
            $this->setLifecycle($acc, 'migrating', "Chuyển sang {$target->name}", $actor);
            $spec = new JobSpec('hosting_account.migrate', $m, $acc->server_id, 3, 6 * 3600);
            $this->backups->accountSteps($spec, $repo, $acc, ['files', 'databases'], ['manual']);
            $job = $this->jobs->dispatch($spec, $actor, $idempotencyKey);
            $m->forceFill(['job_id' => $job->id])->save();
            $this->audit->record('hosting_account.migrate', $acc, ['migration' => $m->uuid, 'target' => $target->name,
                'keep_source_days' => $keepDays], 'success', $acc->server_id, $job->id, $actor);

            return $job;
        });
    }

    /** Chặng 2 (đích): dựng account + dữ liệu từ snapshot lượt đầu rồi kiểm chứng. */
    /** @param  array<string, string>  $dbSnaps  tên DB → snapshot */
    public function dispatchSync(AccountMigration $m, string $filesSnap, array $dbSnaps, ?User $actor): Job
    {
        $a = HostingAccount::query()->findOrFail($m->hosting_account_id);
        $repo = $this->repo($m);
        $limits = $this->quota->limits($a);
        $spec = new JobSpec('migration.sync', $m, $m->target_server_id, 3, 6 * 3600);
        $spec->step('migrate.preflight', $this->preflightParams($m, $a, $repo));
        $spec->step('account.ensure', ['account' => ProvisioningService::ref($a), 'home_path' => $a->home_path,
            'shell' => $limits['ssh_allowed'] ? '/bin/bash' : '/usr/sbin/nologin', 'limits' => ProvisioningService::agentLimits($limits)])
            ->step('quota.apply', ['account' => ProvisioningService::ref($a), 'limits' => ProvisioningService::agentLimits($limits)]);
        foreach ($this->dbs($a)->groupBy(fn (Database $d): string => DataSpec::engine($d->engine)) as $engine => $list) {
            $spec->step(DataSpec::op($engine, 'owner_ensure'), ['account' => DataSpec::acct($a)]);
            foreach ($list as $d) {
                $spec->step(DataSpec::op($engine, 'create'), ['account' => DataSpec::acct($a), 'name' => $d->name, 'charset' => $d->charset]);
            }
        }
        $sites = $this->sites($a);
        foreach ($sites as $w) {
            $spec->step('fs.site_layout.ensure', WebsiteSpec::layout($w, $a));
        }
        $this->restoreSteps($spec, $m, $a, $repo, $filesSnap, $dbSnaps);
        $this->configSteps($spec, $a, $sites, $limits['ssh_allowed']);
        $spec->step('migrate.verify', $this->verifyParams($m, $a, $repo, $filesSnap));
        $this->dnsSteps($spec, $m, 'lower_ttl');

        return $this->jobs->dispatch($spec, $actor);
    }

    // ------------------------------------------------------------------ cutover / rollback / cleanup

    public function cutover(User $actor, AccountMigration $m, ?string $idempotencyKey = null): Job
    {
        return DB::transaction(function () use ($actor, $m, $idempotencyKey): Job {
            /** @var AccountMigration $m */
            $m = AccountMigration::query()->lockForUpdate()->findOrFail($m->id);
            $this->ensureIdle($m);
            if ($m->state !== 'verifying') {
                throw new ApiProblem(409, 'invalid_state_transition', 'Chưa cutover được', "Lượt chuyển đang {$m->state}: cutover chỉ sau khi đồng bộ và kiểm chứng xong.");
            }
            $bad = collect($m->verification)->where('ok', false)->pluck('name')->all();
            if ($m->verification === [] || $bad !== []) {
                throw new ApiProblem(409, 'precondition_failed', 'Kiểm chứng chưa khớp', 'Không cutover khi kiểm chứng lệch: '.implode(', ', $bad ?: ['chưa có kết quả']));
            }
            $a = HostingAccount::query()->findOrFail($m->hosting_account_id);
            $repo = $this->repo($m);
            $spec = (new JobSpec('migration.cutover', $m, $m->source_server_id, 3, 6 * 3600))
                ->step('migrate.cutover', ['account' => DataSpec::acct($a), 'migration_uuid' => $m->uuid, 'role' => 'source']);
            $this->backups->accountSteps($spec, $repo, $a, ['files', 'databases'], ['final']);
            $job = $this->jobs->dispatch($spec, $actor, $idempotencyKey);
            $m->forceFill(['state' => 'cutover', 'job_id' => $job->id, 'error' => null, 'cutover_at' => Carbon::now()])->save();
            $this->audit->record('migration.cutover', $m, ['account' => $a->username], 'success', $m->source_server_id, $job->id, $actor);

            return $job;
        });
    }

    /** Chặng cutover 2 (đích): restore lượt cuối → verify → mở account → http.check → DNS. */
    /** @param  array<string, string>  $dbSnaps  tên DB → snapshot */
    public function dispatchCutoverTarget(AccountMigration $m, string $filesSnap, array $dbSnaps, ?User $actor): Job
    {
        $a = HostingAccount::query()->findOrFail($m->hosting_account_id);
        $repo = $this->repo($m);
        $spec = new JobSpec('migration.cutover_target', $m, $m->target_server_id, 3, 6 * 3600);
        $this->restoreSteps($spec, $m, $a, $repo, $filesSnap, $dbSnaps);
        $spec->step('migrate.verify', $this->verifyParams($m, $a, $repo, $filesSnap))
            ->step('migrate.cutover', ['account' => DataSpec::acct($a), 'migration_uuid' => $m->uuid, 'role' => 'target']);
        foreach ($this->sites($a) as $w) {
            $spec->step('http.check', ['host' => $w->primary_domain, 'path' => '/', 'scheme' => 'http',
                'expect_status' => [200, 201, 204, 301, 302, 303, 307, 308, 401, 403]]);
        }
        $this->dnsSteps($spec, $m, 'switch');

        return $this->jobs->dispatch($spec, $actor);
    }

    public function rollback(User $actor, AccountMigration $m, ?string $idempotencyKey = null): Job
    {
        return DB::transaction(function () use ($actor, $m, $idempotencyKey): Job {
            /** @var AccountMigration $m */
            $m = AccountMigration::query()->lockForUpdate()->findOrFail($m->id);
            $this->ensureIdle($m);
            if (! in_array($m->state, ['verifying', 'cutover', 'holding', 'failed'], true) || $m->cleaned_at !== null) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Không hoàn tác được', "Lượt chuyển đang {$m->state}: chỉ hoàn tác trước khi dọn nguồn.");
            }
            $a = HostingAccount::query()->findOrFail($m->hosting_account_id);
            $targetReady = $this->targetPrepared($m);
            $spec = $targetReady
                ? (new JobSpec('migration.rollback', $m, $m->target_server_id, 3, 3600))
                    ->step('migrate.rollback', ['account' => DataSpec::acct($a), 'migration_uuid' => $m->uuid, 'role' => 'target'])
                : (new JobSpec('migration.rollback_source', $m, $m->source_server_id, 3, 3600))
                    ->step('migrate.rollback', ['account' => DataSpec::acct($a), 'migration_uuid' => $m->uuid, 'role' => 'source']);
            if ($targetReady && $m->dns !== null && ($m->dns['switched'] ?? false)) {
                $this->dnsSteps($spec, $m, 'revert');
            }
            $job = $this->jobs->dispatch($spec, $actor, $idempotencyKey);
            $m->forceFill(['job_id' => $job->id])->save();
            $this->audit->record('migration.rollback', $m, ['account' => $a->username, 'from_state' => $m->state], 'success',
                $spec->serverId, $job->id, $actor);

            return $job;
        });
    }

    public function dispatchRollbackSource(AccountMigration $m, ?User $actor): Job
    {
        $a = HostingAccount::query()->findOrFail($m->hosting_account_id);
        $spec = (new JobSpec('migration.rollback_source', $m, $m->source_server_id, 3, 3600))
            ->step('migrate.rollback', ['account' => DataSpec::acct($a), 'migration_uuid' => $m->uuid, 'role' => 'source']);

        return $this->jobs->dispatch($spec, $actor);
    }

    public function cleanup(?User $actor, AccountMigration $m, ?string $confirmUsername, bool $early, ?string $idempotencyKey = null): Job
    {
        return DB::transaction(function () use ($actor, $m, $confirmUsername, $early, $idempotencyKey): Job {
            /** @var AccountMigration $m */
            $m = AccountMigration::query()->lockForUpdate()->findOrFail($m->id);
            $this->ensureIdle($m);
            $a = HostingAccount::query()->findOrFail($m->hosting_account_id);
            if ($m->state !== 'holding') {
                throw new ApiProblem(409, 'invalid_state_transition', 'Chưa dọn được', "Lượt chuyển đang {$m->state}: chỉ dọn nguồn khi đang giữ nguồn (holding).");
            }
            if ($actor !== null && $confirmUsername !== $a->username) {
                throw ApiProblem::field('confirm_username', 'Gõ đúng username account để xác nhận dọn server nguồn.');
            }
            if ($early && ($m->cleanup_after === null || $m->cleanup_after->isFuture()) && $actor?->roleKey() !== 'SUPER_ADMIN') {
                throw new ApiProblem(403, 'forbidden', 'Chưa tới hạn giữ nguồn', 'Dọn sớm trước hạn chỉ SUPER_ADMIN được xác nhận.');
            }
            $spec = (new JobSpec('migration.cleanup', $m, $m->source_server_id, 3, 3600))
                ->step('account.remove', ['account' => DataSpec::acct($a), 'reason' => 'migrated', 'ref_uuid' => $m->uuid,
                    'final_snapshot_id' => (string) $m->final_snapshot_id, 'confirm_username' => $a->username, 'confirm' => true]);
            $job = $this->jobs->dispatch($spec, $actor, $idempotencyKey);
            $m->forceFill(['job_id' => $job->id])->save();
            $this->audit->record('migration.cleanup', $m, ['account' => $a->username, 'early' => $early], 'success',
                $m->source_server_id, $job->id, $actor);

            return $job;
        });
    }

    // ------------------------------------------------------------------ trạng thái (gọi từ handler)

    /** Cutover xong ở đích: account (và site/DB) sang server đích, giữ nguồn tới cleanup_after. */
    public function completeCutover(AccountMigration $m): void
    {
        $a = HostingAccount::query()->lockForUpdate()->findOrFail($m->hosting_account_id);
        $started = $m->cutover_at ?? Carbon::now();
        DB::table('uid_allocations')->updateOrInsert(['server_id' => $m->target_server_id, 'uid' => $a->uid],
            ['hosting_account_id' => $a->id, 'allocated_at' => Carbon::now(), 'released_at' => null]);
        foreach (['websites', 'databases', 'database_users'] as $t) {
            DB::table($t)->where('hosting_account_id', $a->id)->update(['server_id' => $m->target_server_id]);
        }
        $a->server_id = $m->target_server_id;
        $a->save();
        $this->setLifecycle($a, 'active', 'Chuyển server xong', null);
        $dns = $m->dns;
        if ($dns !== null && $dns['mode'] === 'auto') {
            $dns['switched'] = true;
        }
        $m->forceFill(['state' => 'holding', 'downtime_sec' => (int) max(0, $started->diffInSeconds(Carbon::now())),
            'cleanup_after' => Carbon::now()->addDays($m->keep_source_days), 'error' => null, 'dns' => $dns])->save();
        $this->notifyAdmins($m, 'migration.holding', "{$a->username} đã chạy ở server mới",
            'Cutover xong; server nguồn giữ bản khóa tới '.$m->cleanup_after?->toDateString().'.', 'info');
    }

    public function completeRollback(AccountMigration $m): void
    {
        $a = HostingAccount::query()->lockForUpdate()->findOrFail($m->hosting_account_id);
        if ($a->server_id !== $m->source_server_id) {
            foreach (['websites', 'databases', 'database_users'] as $t) {
                DB::table($t)->where('hosting_account_id', $a->id)->update(['server_id' => $m->source_server_id]);
            }
            $a->server_id = $m->source_server_id;
            $a->save();
        }
        DB::table('uid_allocations')->where('server_id', $m->target_server_id)->where('uid', $a->uid)
            ->where('hosting_account_id', $a->id)->update(['released_at' => Carbon::now()]);
        $this->setLifecycle($a, 'active', 'Hoàn tác chuyển server', null);
        $m->forceFill(['state' => 'rolled_back', 'error' => null, 'cleanup_after' => null])->save();
        $this->notifyAdmins($m, 'migration.rolled_back', "{$a->username} đã hoàn tác về server cũ", 'Account chạy lại ở server nguồn.', 'medium');
    }

    public function fail(AccountMigration $m, string $error): void
    {
        $a = HostingAccount::query()->lockForUpdate()->findOrFail($m->hosting_account_id);
        // Trước cutover: nguồn chưa bị khóa → account hoạt động lại ngay. Từ cutover: giữ migrating, chờ admin hoàn tác.
        if (in_array($m->state, ['preflight', 'syncing', 'verifying'], true) && $a->lifecycle_state === 'migrating') {
            $this->setLifecycle($a, 'active', 'Chuyển server lỗi trước cutover', null);
        }
        $m->forceFill(['state' => 'failed', 'error' => mb_substr($error, 0, 1000)])->save();
        $this->notifyAdmins($m, 'migration.failed', "Chuyển {$a->username} lỗi", mb_substr($error, 0, 500), 'high');
    }

    public function completeCleanup(AccountMigration $m): void
    {
        $a = HostingAccount::query()->findOrFail($m->hosting_account_id);
        DB::table('uid_allocations')->where('server_id', $m->source_server_id)->where('uid', $a->uid)->update(['released_at' => Carbon::now()]);
        $m->forceFill(['state' => 'completed', 'cleaned_at' => Carbon::now()])->save();
    }

    // ------------------------------------------------------------------ dựng bước

    private function repo(AccountMigration $m): BackupRepository
    {
        return BackupRepository::query()->where('uuid', (string) ($m->preflight['repo_uuid'] ?? ''))->firstOrFail();
    }

    /** @return Collection<int, Website> */
    private function sites(HostingAccount $a)
    {
        return Website::query()->where('hosting_account_id', $a->id)->whereNotIn('status', ['deleting', 'failed', 'pending'])->orderBy('id')->get();
    }

    /** @return Collection<int, Database> */
    private function dbs(HostingAccount $a)
    {
        return Database::query()->where('hosting_account_id', $a->id)->where('status', 'ready')->orderBy('name')->get();
    }

    /** @return array<string, mixed> */
    private function preflightParams(AccountMigration $m, HostingAccount $a, BackupRepository $repo): array
    {
        $sites = $this->sites($a);

        return ['account' => DataSpec::acct($a), 'migration_uuid' => $m->uuid, 'repo' => BackupSpec::repo($repo),
            'need_bytes' => (int) ($m->preflight['estimate']['bytes'] ?? 0),
            'php_versions' => array_values(array_unique(array_filter($sites->pluck('php_version')->all()))),
            'databases' => $this->dbs($a)->map(fn (Database $d): array => ['engine' => DataSpec::engine($d->engine), 'name' => $d->name])->values()->all(),
            'sites' => $sites->pluck('primary_domain')->values()->all()];
    }

    /** @return array<string, mixed> */
    private function verifyParams(AccountMigration $m, HostingAccount $a, BackupRepository $repo, string $filesSnap): array
    {
        return ['account' => DataSpec::acct($a), 'migration_uuid' => $m->uuid, 'repo' => BackupSpec::repo($repo), 'snapshot_id' => $filesSnap,
            'databases' => $this->dbs($a)->map(fn (Database $d): array => ['engine' => DataSpec::engine($d->engine), 'name' => $d->name])->values()->all(),
            'sites' => $this->sites($a)->pluck('primary_domain')->values()->all()];
    }

    /** @param  array<string, string>  $dbSnaps  tên DB → snapshot */
    private function restoreSteps(JobSpec $spec, AccountMigration $m, HostingAccount $a, BackupRepository $repo, string $filesSnap, array $dbSnaps): void
    {
        $items = $this->sites($a)->map(fn (Website $w): array => ['kind' => 'website', 'site_dir' => $w->primary_domain])->values()->all();
        $n = 0;
        $rid = fn (): string => self::subUuid($m->uuid, $spec->type.':'.(++$n));
        if ($items !== []) {
            $spec->step('backup.restore', ['repo' => BackupSpec::repo($repo), 'snapshot_id' => $filesSnap, 'restore_uuid' => $rid(),
                'account' => DataSpec::acct($a), 'mode' => 'overwrite', 'items' => $items, 'pre_restore_tags' => []]);
        }
        foreach ($this->dbs($a) as $d) {
            if (! isset($dbSnaps[$d->name])) {
                continue;
            }
            $db = ['engine' => DataSpec::engine($d->engine), 'name' => $d->name];
            $spec->step('backup.restore', ['repo' => BackupSpec::repo($repo), 'snapshot_id' => $dbSnaps[$d->name], 'restore_uuid' => $rid(),
                'account' => DataSpec::acct($a), 'mode' => 'overwrite', 'items' => [['kind' => 'database', 'db' => $db, 'target_name' => $d->name]],
                'pre_restore_tags' => []]);
        }
    }

    /**
     * Cấu hình ở đích theo desired state: pool + vhost (HTTP; chứng chỉ cấp lại ở đích sau cutover),
     * DB user + quyền, cron, SFTP/khóa SSH/FTP phụ. Account đang `migrating` nhưng cấu hình đích là bản chạy (không khóa).
     *
     * @param  Collection<int, Website>  $sites
     */
    private function configSteps(JobSpec $spec, HostingAccount $a, $sites, bool $sshAllowed): void
    {
        foreach ($sites as $w) {
            if ($w->type === 'php') {
                $spec->step('php.pool.apply', WebsiteSpec::pool($w, $a));
            }
            // Chứng chỉ: khóa ACME chỉ nằm trên agent nguồn → vhost đích chưa bật HTTPS; cấp lại sau khi DNS trỏ về đích.
            $spec->step('nginx.vhost.apply', WebsiteSpec::vhost($w, $a, false, false));
        }
        foreach (DatabaseUser::query()->where('hosting_account_id', $a->id)->where('status', 'ready')->orderBy('id')->get() as $u) {
            $spec->step(DataSpec::op($u->engine, 'user_ensure'), $this->databases->userParams($u, $a, true));
            foreach (DataSpec::grants($u) as $g) {
                $spec->step(DataSpec::op($u->engine, 'grant'), ['account' => DataSpec::acct($a), 'username' => $u->username] + $g);
            }
        }
        if (CronJob::query()->where('hosting_account_id', $a->id)->exists()) {
            $spec->step('cron.apply', ['account' => DataSpec::acct($a), 'entries' => DataSpec::cronEntries($a, false)]);
        }
        foreach (SftpAccount::query()->where('hosting_account_id', $a->id)->whereNotIn('status', ['deleting', 'failed'])->orderBy('id')->get() as $s) {
            $spec->step($s->protocol === 'ftps' ? 'ftp.user.ensure' : 'sftp.user.ensure', $s->protocol === 'ftps'
                ? DataSpec::ftpUser($s, $a, true) : DataSpec::sftpUser($s, $a, $sshAllowed, true));
        }
        $keys = DataSpec::sshKeys($a);
        if ($keys !== []) {
            $spec->step('ssh.keys.apply', ['account' => DataSpec::acct($a), 'keys' => $keys]);
        }
    }

    /**
     * DNS (ADR 0038): domain có zone do panel quản lý → tự đổi bản ghi A từ IP nguồn sang IP đích (giảm TTL lúc
     * đồng bộ, đổi lúc cutover, trả về khi rollback). Không có zone → hiện bản ghi cần đổi tay.
     *
     * @return array{mode: string, zone: string|null, records: list<array<string, string>>}
     */
    private function dnsPlan(HostingAccount $a, Server $target): array
    {
        $ip = (string) (array_values($target->ip_addresses)[0] ?? '');
        $names = [];
        foreach ($this->sites($a) as $w) {
            $names[] = $w->primary_domain;
            foreach (WebsiteDomain::query()->where('website_id', $w->id)->pluck('name') as $n) {
                $names[] = (string) $n;
            }
        }
        $names = array_values(array_unique($names));
        $zones = [];
        foreach ($names as $n) {
            $z = DnsZone::query()->whereNotNull('external_id')->get()->first(fn (DnsZone $z): bool => $n === $z->name || str_ends_with($n, '.'.$z->name));
            $zones[$n] = $z?->name;
        }
        $auto = $names !== [] && ! in_array(null, $zones, true);
        $zoneNames = array_values(array_unique(array_filter($zones)));

        return ['mode' => $auto ? 'auto' : 'manual', 'zone' => count($zoneNames) === 1 ? $zoneNames[0] : null,
            'records' => array_map(fn (string $n): array => ['type' => 'A', 'name' => $n, 'value' => $ip], $names)];
    }

    /** Bước panel dns.records.apply cho các bản ghi A của domain account (chỉ chế độ auto). */
    private function dnsSteps(JobSpec $spec, AccountMigration $m, string $phase): void
    {
        if (($m->dns['mode'] ?? 'manual') !== 'auto') {
            return;
        }
        $src = (string) (array_values(Server::query()->findOrFail($m->source_server_id)->ip_addresses)[0] ?? '');
        $dst = (string) (array_values(Server::query()->findOrFail($m->target_server_id)->ip_addresses)[0] ?? '');
        foreach ($m->dns['records'] as $want) {
            $z = DnsZone::query()->whereNotNull('external_id')->get()
                ->first(fn (DnsZone $z): bool => $want['name'] === $z->name || str_ends_with($want['name'], '.'.$z->name));
            if (! $z instanceof DnsZone) {
                continue;
            }
            $rel = $want['name'] === $z->name ? '@' : substr($want['name'], 0, -strlen($z->name) - 1);
            foreach (DnsRecord::query()->where('zone_id', $z->id)->where('type', 'A')->where('name', $rel)->get() as $r) {
                $rec = ['type' => 'A', 'name' => $r->name, 'content' => $r->content, 'ttl' => $r->ttl, 'proxied' => $r->proxied];
                if ($phase === 'lower_ttl') {
                    if ($r->content !== $src || $r->ttl <= 60) {
                        continue;
                    }
                    $rec['ttl'] = 60;
                } elseif ($phase === 'switch') {
                    if ($r->content !== $src) {
                        continue;
                    }
                    $rec['content'] = $dst;
                } else { // revert
                    if ($r->content !== $dst) {
                        continue;
                    }
                    $rec['content'] = $src;
                }
                $spec->step('dns.records.apply', ['zone_uuid' => $z->uuid, 'action' => 'update', 'record_uuid' => $r->uuid, 'record' => $rec]);
            }
        }
    }

    // ------------------------------------------------------------------ tiện ích

    private function ensureIdle(AccountMigration $m): void
    {
        if ($m->job_id !== null && Job::query()->whereKey($m->job_id)->whereIn('state', self::ACTIVE_JOB)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Đang có chặng chạy', 'Chờ chặng hiện tại của lượt chuyển xong rồi thử lại.');
        }
    }

    /** Đích đã dựng account (chặng sync đã chạy account.ensure thành công)? */
    public function targetPrepared(AccountMigration $m): bool
    {
        return DB::table('job_steps')->join('jobs', 'jobs.id', '=', 'job_steps.job_id')
            ->where('jobs.resource_type', 'account_migration')->where('jobs.resource_id', $m->id)
            ->where('jobs.type', 'migration.sync')->where('job_steps.op', 'account.ensure')->where('job_steps.state', 'succeeded')->exists();
    }

    private function setLifecycle(HostingAccount $a, string $to, string $reason, ?User $actor): void
    {
        $from = $a->lifecycle_state;
        if ($from === $to) {
            return;
        }
        $a->lifecycle_state = $to;
        $a->save();
        app(ProvisioningService::class)->event($a, $from, $to, $reason, $actor, null);
    }

    private function notifyAdmins(AccountMigration $m, string $type, string $title, string $body, string $severity): void
    {
        User::query()->where('realm', 'admin')->where('status', 'active')
            ->where(fn ($q) => $q->whereHas('roles', fn ($r) => $r->where('key', 'SUPER_ADMIN'))->orWhere('id', $m->requested_by_user_id))
            ->get()->each(fn (User $u) => $this->notifier->notify($u, $type, $title, $body, $severity, '/migrations/'.$m->uuid));
    }

    /** uuid tất định từ uuid lượt chuyển + nhãn (restore_uuid ổn định khi chạy lại). */
    public static function subUuid(string $base, string $label): string
    {
        $h = substr(hash('sha256', $base.'|'.$label), 0, 32);

        return sprintf('%s-%s-4%s-8%s-%s', substr($h, 0, 8), substr($h, 8, 4), substr($h, 13, 3), substr($h, 17, 3), substr($h, 20, 12));
    }
}
