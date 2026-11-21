<?php

declare(strict_types=1);

namespace App\Domain\Hosting;

use App\Domain\Audit\AuditLogger;
use App\Domain\Data\DataSpec;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Domain\Web\WebsiteSpec;
use App\Exceptions\ApiProblem;
use App\Models\AccountLifecycleEvent;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\HostingPackageVersion;
use App\Models\Job;
use App\Models\Server;
use App\Models\SshKey;
use App\Models\User;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Hosting Provisioning Service (D-49): lớp nội bộ duy nhất thay đổi hosting account. Mọi thao tác: kiểm trạng thái
 * + quota → cập nhật desired state + ghi lifecycle event + audit trong một transaction → job agent (sau commit).
 */
final class ProvisioningService
{
    public const RESERVED = ['root', 'admin', 'www', 'mysql', 'postgres', 'redis', 'nginx', 'itso', 'daemon', 'bin', 'sys',
        'sync', 'games', 'man', 'mail', 'news', 'proxy', 'backup', 'list', 'nobody', 'systemd', 'sshd', 'ftp', 'test',
        'user', 'support'];

    public const ACTIVE_JOB_STATES = ['queued', 'running', 'cancel_requested', 'waiting_agent'];

    public function __construct(
        private readonly JobDispatcher $jobs,
        private readonly QuotaService $quota,
        private readonly UidAllocator $uids,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  array<string, int>  $override
     * @return array{0: HostingAccount, 1: Job}
     */
    public function create(User $actor, User $owner, HostingPackage $package, Server $server, string $username, array $override = []): array
    {
        if (preg_match('/^[a-z][a-z0-9]{2,15}$/', $username) !== 1 || in_array($username, self::RESERVED, true)) {
            throw ApiProblem::field('username', 'Username 3–16 ký tự a-z0-9, bắt đầu bằng chữ, không trùng tên hệ thống.');
        }
        if ($owner->realm !== 'portal' || $owner->status !== 'active') {
            throw ApiProblem::field('owner_user_uuid', 'Chủ account phải là USER Portal đang hoạt động.');
        }
        if (! $package->is_active) {
            throw ApiProblem::field('package_uuid', 'Gói đã ngừng bán.');
        }
        if (! $server->accepting_new_accounts) {
            throw new ApiProblem(422, 'server_not_accepting', 'Server không nhận account mới', "Server {$server->name} đang tắt nhận account mới.",
                ['server_uuid' => ['Server không nhận account mới.']]);
        }
        $version = $this->currentVersion($package);

        return DB::transaction(function () use ($actor, $owner, $server, $username, $override, $version): array {
            if (HostingAccount::query()->withTrashed()->where('server_id', $server->id)->where('username', $username)->exists()) {
                throw ApiProblem::conflict("Username $username đã có trên server {$server->name}.");
            }
            $uid = $this->uids->allocate($server->id);
            $a = HostingAccount::query()->create([
                'server_id' => $server->id, 'package_version_id' => $version->id, 'owner_user_id' => $owner->id,
                'username' => $username, 'uid' => $uid, 'home_path' => '/home/'.$username,
                'lifecycle_state' => 'provisioning', 'status' => 'provisioning', 'limits_override' => $override,
            ]);
            $this->uids->bind($server->id, $uid, $a->id);
            $limits = $this->quota->limits($a, $version);
            $spec = (new JobSpec('hosting_account.create', $a, $server->id))
                ->step('account.ensure', ['account' => self::ref($a), 'home_path' => $a->home_path,
                    'shell' => $limits['ssh_allowed'] ? '/bin/bash' : '/usr/sbin/nologin', 'limits' => self::agentLimits($limits)])
                ->step('quota.apply', ['account' => self::ref($a), 'limits' => self::agentLimits($limits)]);
            $job = $this->dispatch($spec, $actor, [$a]);
            $this->event($a, null, 'provisioning', null, $actor, $job);
            $this->audit->record('hosting_account.create', $a, ['username' => $username, 'server' => $server->name,
                'package_version_id' => $version->id], 'success', $server->id, $job->id, $actor);

            return [$a, $job];
        });
    }

    public function suspend(User $actor, HostingAccount $a, string $reason): Job
    {
        return $this->transition($actor, $a, 'suspend', $reason, ['suspended_reason' => $reason],
            fn (JobSpec $s) => WebsiteSpec::reapplyAccount(
                $s->step('account.suspend', ['account' => self::ref($a), 'reason' => $reason]), $a, true));
    }

    /** Mở khóa (suspended → active) hoặc khôi phục account đã chấm dứt trong thời gian giữ (terminated → active). */
    public function unsuspend(User $actor, HostingAccount $a): Job
    {
        if ($a->lifecycle_state === 'terminated') {
            if ($a->purge_after !== null && $a->purge_after->isPast()) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Đã quá thời gian giữ',
                    'Account đã quá hạn giữ dữ liệu, chờ purge; không khôi phục được.');
            }

            return $this->transition($actor, $a, 'restore', 'Khôi phục trong thời gian giữ',
                ['terminated_at' => null, 'purge_after' => null, 'suspended_reason' => null],
                fn (JobSpec $s) => WebsiteSpec::reapplyAccount($s->step('account.unsuspend', ['account' => self::ref($a)]), $a, false));
        }

        return $this->transition($actor, $a, 'unsuspend', null, ['suspended_reason' => null],
            fn (JobSpec $s) => WebsiteSpec::reapplyAccount($s->step('account.unsuspend', ['account' => self::ref($a)]), $a, false));
    }

    public function terminate(User $actor, HostingAccount $a, string $reason, string $confirmUsername): Job
    {
        if (! hash_equals($a->username, $confirmUsername)) {
            throw new ApiProblem(422, 'confirmation_mismatch', 'Xác nhận không khớp', 'confirm_username phải trùng username account.',
                ['confirm_username' => ['Không trùng username account.']]);
        }
        $days = max(30, (int) $this->quota->limits($a)['retention_days_after_terminate']);
        $now = Carbon::now();

        return $this->transition($actor, $a, 'terminate', $reason,
            ['terminated_at' => $now, 'purge_after' => $now->copy()->addDays($days), 'suspended_reason' => $reason],
            fn (JobSpec $s) => WebsiteSpec::reapplyAccount(
                $s->step('account.suspend', ['account' => self::ref($a), 'reason' => 'terminated: '.$reason]), $a, true));
    }

    public function changePackage(User $actor, HostingAccount $a, HostingPackage $package, ?int $version, ?string $reason): Job
    {
        $v = $version === null ? $this->currentVersion($package)
            : HostingPackageVersion::query()->where('package_id', $package->id)->where('version', $version)->first();
        if (! $v instanceof HostingPackageVersion) {
            throw ApiProblem::field('version', 'Gói không có phiên bản này.');
        }
        if ($v->id === $a->package_version_id) {
            throw ApiProblem::field('package_uuid', 'Account đã dùng đúng gói/phiên bản này.');
        }
        $new = $this->quota->limits(self::withVersion($a, $v), $v);
        $this->quota->ensureFits($a, $new);

        return $this->transition($actor, $a, 'change_package', $reason, ['package_version_id' => $v->id],
            fn (JobSpec $s) => $s->step('quota.apply', ['account' => self::ref($a), 'limits' => self::agentLimits($new)]),
            ['from_version_id' => $a->package_version_id, 'to_version_id' => $v->id]);
    }

    /** @param  array<string, int>  $override */
    public function updateOverride(User $actor, HostingAccount $a, array $override): ?Job
    {
        $probe = self::withVersion($a, null);
        $probe->limits_override = $override;
        $new = $this->quota->limits($probe);
        $this->quota->ensureFits($a, $new);
        if (! in_array($a->lifecycle_state, ['active', 'suspended'], true)) {
            $a->limits_override = $override;
            $a->spec_version++;
            $a->save();

            return null;
        }

        return $this->transition($actor, $a, 'update', null, ['limits_override' => $override],
            fn (JobSpec $s) => $s->step('quota.apply', ['account' => self::ref($a), 'limits' => self::agentLimits($new)]),
            ['limits_override' => $override]);
    }

    /** Chuyển mọi account đang ở phiên bản `$from` sang phiên bản hiện tại của gói (một job, mỗi account một bước). */
    public function migrateVersion(User $actor, HostingPackage $package, HostingPackageVersion $from): Job
    {
        $to = $this->currentVersion($package);
        if ($from->id === $to->id) {
            throw ApiProblem::field('version', 'Đây đã là phiên bản hiện tại.');
        }

        return DB::transaction(function () use ($actor, $package, $from, $to): Job {
            $accounts = HostingAccount::query()->where('package_version_id', $from->id)
                ->whereIn('lifecycle_state', ['active', 'suspended'])->lockForUpdate()->orderBy('id')->get();
            if ($accounts->isEmpty()) {
                throw ApiProblem::field('version', 'Không có account active/suspended ở phiên bản này.');
            }
            $spec = new JobSpec('package.migrate_accounts', $package, null, 3, 600 + 30 * $accounts->count());
            foreach ($accounts as $a) {
                $this->ensureIdle($a);
                $new = $this->quota->limits(self::withVersion($a, $to), $to);
                $this->quota->ensureFits($a, $new);
                $spec->step('quota.apply', ['account' => self::ref($a), 'limits' => self::agentLimits($new)]);
                $a->package_version_id = $to->id;
                $a->spec_version++;
                $a->save();
            }
            $job = $this->dispatch($spec, $actor, $accounts->all());
            $this->audit->record('hosting_package.migrate_accounts', $package, ['from_version' => $from->version,
                'to_version' => $to->version, 'accounts' => $accounts->count()], 'success', null, $job->id, $actor);

            return $job;
        });
    }

    /**
     * Áp lại desired state của account xuống agent (account.ensure + quota.apply, khóa lại nếu suspended/terminated):
     * dùng khi agent mất trạng thái (mock khởi động lại) hoặc khi nạp dữ liệu demo.
     */
    public function reconcile(HostingAccount $a, ?User $actor = null): Job
    {
        return DB::transaction(function () use ($a, $actor): Job {
            /** @var HostingAccount $a */
            $a = HostingAccount::query()->lockForUpdate()->findOrFail($a->id);
            if (! in_array($a->lifecycle_state, ['active', 'suspended', 'terminated'], true)) {
                throw new ApiProblem(409, 'invalid_state_transition', 'Không đồng bộ được', "Account đang {$a->lifecycle_state}.");
            }
            $this->ensureIdle($a);
            $limits = $this->quota->limits($a);
            $spec = (new JobSpec('hosting_account.reconcile', $a, $a->server_id))
                ->step('account.ensure', ['account' => self::ref($a), 'home_path' => $a->home_path,
                    'shell' => $limits['ssh_allowed'] ? '/bin/bash' : '/usr/sbin/nologin', 'limits' => self::agentLimits($limits)])
                ->step('quota.apply', ['account' => self::ref($a), 'limits' => self::agentLimits($limits)]);
            if ($a->lifecycle_state !== 'active') {
                $spec->step('account.suspend', ['account' => self::ref($a), 'reason' => (string) ($a->suspended_reason ?: $a->lifecycle_state)]);
            }
            // Website (Phase 5): dựng lại bố cục, pool, vhost theo desired state.
            foreach (Website::query()->where('hosting_account_id', $a->id)->whereIn('status', ['ready', 'degraded', 'suspended'])->orderBy('id')->get() as $w) {
                WebsiteSpec::provision($spec, $w, $a);
            }
            // Dữ liệu (Phase 6): khóa SSH, cron, FTP phụ, khóa DB theo trạng thái account.
            if (SshKey::query()->where('hosting_account_id', $a->id)->exists()) {
                $spec->step('ssh.keys.apply', ['account' => self::ref($a), 'keys' => DataSpec::sshKeys($a)]);
            }
            DataSpec::reapplyAccount($spec, $a, $a->lifecycle_state !== 'active');
            $job = $this->dispatch($spec, $actor, [$a]);

            return $job;
        });
    }

    public function currentVersion(HostingPackage $p): HostingPackageVersion
    {
        return HostingPackageVersion::query()->where('package_id', $p->id)->where('version', $p->current_version)->firstOrFail();
    }

    /** 409 resource_locked nếu account đang có job chưa xong. */
    public function ensureIdle(HostingAccount $a): void
    {
        if ($a->last_job_id !== null && Job::query()->whereKey($a->last_job_id)->whereIn('state', self::ACTIVE_JOB_STATES)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Account đang có tác vụ chạy', 'Chờ tác vụ hiện tại xong rồi thử lại.');
        }
        // Website của account đang áp cấu hình (vhost): đợi xong để không ghi đè trạng thái suspended.
        $siteJobs = Website::query()->where('hosting_account_id', $a->id)->whereNotNull('last_job_id')->select('last_job_id');
        if (Job::query()->whereIn('id', $siteJobs)->whereIn('state', self::ACTIVE_JOB_STATES)->exists()) {
            throw new ApiProblem(409, 'resource_locked', 'Website của account đang có tác vụ chạy', 'Chờ tác vụ website xong rồi thử lại.');
        }
    }

    /**
     * @param  array<string, mixed>  $desired  cột đổi ngay (desired state)
     * @param  callable(JobSpec): JobSpec  $steps
     * @param  array<string, mixed>|null  $auditChanges
     */
    private function transition(User $actor, HostingAccount $a, string $action, ?string $reason, array $desired, callable $steps,
        ?array $auditChanges = null): Job
    {
        return DB::transaction(function () use ($actor, $a, $action, $reason, $desired, $steps, $auditChanges): Job {
            /** @var HostingAccount $locked */
            $locked = HostingAccount::query()->lockForUpdate()->findOrFail($a->id);
            AccountLifecycle::assert($action, $locked);
            $this->ensureIdle($locked);
            $from = $locked->lifecycle_state;
            $to = AccountLifecycle::TO[$action] ?? $from;
            $locked->fill($desired);
            $locked->lifecycle_state = $to;
            $locked->spec_version++;
            $locked->save();
            $job = $this->dispatch($steps(new JobSpec('hosting_account.'.$action, $locked, $locked->server_id)), $actor, [$locked]);
            if ($to !== $from) {
                $this->event($locked, $from, $to, $reason, $actor, $job);
            }
            $this->audit->record('hosting_account.'.$action, $locked, $auditChanges ?? array_filter(['from' => $from, 'to' => $to,
                'reason' => $reason]), 'success', $locked->server_id, $job->id, $actor);
            $a->setRawAttributes($locked->getAttributes(), true);

            return $job;
        });
    }

    /** @param  array<int, HostingAccount>  $accounts */
    private function dispatch(JobSpec $spec, ?User $actor, array $accounts): Job
    {
        $job = $this->jobs->dispatch($spec, $actor);
        HostingAccount::query()->whereKey(array_map(fn (HostingAccount $a): int => $a->id, $accounts))
            ->update(['last_job_id' => $job->id]);
        foreach ($accounts as $a) {
            $a->last_job_id = $job->id;
        }

        return $job;
    }

    public function event(HostingAccount $a, ?string $from, string $to, ?string $reason, ?User $actor, ?Job $job): void
    {
        AccountLifecycleEvent::query()->create(['hosting_account_id' => $a->id, 'from_state' => $from, 'to_state' => $to,
            'reason' => $reason, 'actor_user_id' => $actor?->id, 'job_id' => $job?->id, 'at' => Carbon::now()]);
    }

    /** @return array{username: string, uid: int} */
    public static function ref(HostingAccount $a): array
    {
        return ['username' => $a->username, 'uid' => $a->uid];
    }

    /**
     * Limits theo schema agent (contracts/agent-ops defs Limits).
     *
     * @param  array<string, mixed>  $l
     * @return array<string, int|null>
     */
    public static function agentLimits(array $l): array
    {
        return ['disk_mb' => $l['disk_mb'], 'inode_limit' => $l['inode_limit'], 'cpu_percent' => $l['cpu_percent'],
            'ram_mb' => $l['ram_mb'], 'tasks_max' => $l['tasks_max'], 'io_weight' => $l['io_weight'],
            'io_read_bps' => $l['io_read_bps'], 'io_write_bps' => $l['io_write_bps']];
    }

    private static function withVersion(HostingAccount $a, ?HostingPackageVersion $v): HostingAccount
    {
        $probe = $a->replicate();
        $probe->id = $a->id;
        if ($v !== null) {
            $probe->package_version_id = $v->id;
        }

        return $probe;
    }
}
