<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Domain\Hosting\PackageLimits;
use App\Domain\Hosting\QuotaService;
use App\Models\AccountLifecycleEvent;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\HostingPackageVersion;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use App\Support\PublicId;
use Illuminate\Support\Facades\DB;

/** Gói, phiên bản gói, hosting account, usage, features, lifecycle event theo contracts/openapi. */
final class HostingPresenter
{
    public function __construct(private readonly QuotaService $quota) {}

    /** @return array<string, mixed> */
    public function package(HostingPackage $p): array
    {
        $v = HostingPackageVersion::query()->where('package_id', $p->id)->where('version', $p->current_version)->firstOrFail();

        return [
            'uuid' => $p->uuid,
            'code' => $p->code,
            'name' => $p->name,
            'description' => $p->description,
            'current_version' => $p->current_version,
            'is_active' => $p->is_active,
            'account_count' => self::accountCount(HostingPackageVersion::query()->where('package_id', $p->id)->pluck('id')->all()),
            'limits' => PackageLimits::of($v),
            'created_at' => $p->created_at->toIso8601String(),
            'updated_at' => $p->updated_at->toIso8601String(),
        ];
    }

    public static function packageEtag(HostingPackage $p): string
    {
        return '"pkg-'.sha1(json_encode([$p->name, $p->description, $p->is_active, $p->current_version,
            $p->updated_at->format('U.u')], JSON_THROW_ON_ERROR)).'"';
    }

    /** @return array<string, mixed> */
    public function version(HostingPackageVersion $v, HostingPackage $p): array
    {
        $by = $v->created_by_user_id !== null ? User::query()->find($v->created_by_user_id) : null;

        return [
            'uuid' => PublicId::encode('package_version', $v->id),
            'package_uuid' => $p->uuid,
            'version' => $v->version,
            'limits' => PackageLimits::of($v),
            'account_count' => self::accountCount([$v->id]),
            'created_by' => self::userRef($by),
            'created_at' => $v->created_at->toIso8601String(),
        ];
    }

    /** @return array<string, mixed> */
    public function account(HostingAccount $a): array
    {
        $v = $this->refs['v'][$a->package_version_id] ?? HostingPackageVersion::query()->findOrFail($a->package_version_id);
        $p = $this->refs['p'][$v->package_id] ?? HostingPackage::query()->withTrashed()->findOrFail($v->package_id);
        $server = $this->refs['s'][$a->server_id] ?? Server::query()->withTrashed()->findOrFail($a->server_id);
        $owner = array_key_exists((int) $a->owner_user_id, $this->refs['u']) ? $this->refs['u'][(int) $a->owner_user_id]
            : User::query()->find($a->owner_user_id);

        return [
            'uuid' => $a->uuid,
            'username' => $a->username,
            'server' => ['uuid' => $server->uuid, 'name' => $server->name],
            'package' => self::packageRef($p, $v),
            'owner' => self::userRef($owner),
            'uid' => $a->uid,
            'home_path' => $a->home_path,
            'lifecycle_state' => $a->lifecycle_state,
            'suspended_reason' => $a->suspended_reason,
            'terminated_at' => $a->terminated_at?->toIso8601String(),
            'purge_after' => $a->purge_after?->toIso8601String(),
            'legal_hold' => $a->legal_hold,
            'usage' => $this->quota->usage($a, $v),
            'status' => $a->status,
            'spec_version' => max(1, $a->spec_version),
            'observed_version' => max(0, $a->observed_version),
            'drift' => $a->drift === null || $a->drift === [] ? null : array_map('strval', $a->drift),
            'observed_at' => $a->observed_at?->toIso8601String(),
            'created_at' => $a->created_at->toIso8601String(),
            'updated_at' => $a->updated_at->toIso8601String(),
        ];
    }

    /** @var array{v: array<int, HostingPackageVersion>, p: array<int, HostingPackage>, s: array<int, Server>, u: array<int, User|null>} */
    private array $refs = ['v' => [], 'p' => [], 's' => [], 'u' => []];

    /**
     * Nạp trước gói/phiên bản/server/chủ + mức dùng cho cả trang danh sách (Prompt 12.5): số truy vấn không tăng theo số dòng.
     *
     * @param  list<HostingAccount>  $accounts
     */
    public function prefetch(array $accounts): void
    {
        $col = fn (string $k): array => array_values(array_unique(array_map(fn (HostingAccount $a): int => (int) $a->{$k}, $accounts)));
        $this->refs['v'] = HostingPackageVersion::query()->whereIn('id', $col('package_version_id'))->get()->keyBy('id')->all();
        $this->refs['p'] = HostingPackage::query()->withTrashed()
            ->whereIn('id', array_map(fn (HostingPackageVersion $v): int => $v->package_id, $this->refs['v']))->get()->keyBy('id')->all();
        $this->refs['s'] = Server::query()->withTrashed()->whereIn('id', $col('server_id'))->get()->keyBy('id')->all();
        $users = User::query()->whereIn('id', $col('owner_user_id'))->get()->keyBy('id');
        $this->refs['u'] = array_map(fn (int $id): ?User => $users->get($id), array_combine($col('owner_user_id'), $col('owner_user_id')));
        $this->quota->prefetchUsage(array_map(fn (HostingAccount $a): int => $a->id, $accounts));
    }

    public static function accountEtag(HostingAccount $a): string
    {
        return '"acc-'.sha1(json_encode([$a->spec_version, $a->owner_user_id, $a->legal_hold, $a->lifecycle_state,
            $a->updated_at->format('U.u')], JSON_THROW_ON_ERROR)).'"';
    }

    /** @return array<string, mixed> */
    public function features(HostingAccount $a): array
    {
        $v = HostingPackageVersion::query()->findOrFail($a->package_version_id);
        $p = HostingPackage::query()->withTrashed()->findOrFail($v->package_id);
        $l = $this->quota->limits($a, $v);

        return [
            'package' => self::packageRef($p, $v),
            'php_versions' => $l['php_versions'],
            'php_workers_max' => $l['php_workers_max'],
            'ssh_allowed' => $l['ssh_allowed'],
            'cron_min_interval_min' => $l['cron_min_interval_min'],
            'backup_quota_mb' => $l['backup_quota_mb'],
            'backup_retention' => $l['backup_retention'],
        ];
    }

    /** @return array<string, mixed> */
    public static function event(AccountLifecycleEvent $e): array
    {
        $job = $e->job_id !== null ? Job::query()->whereKey($e->job_id)->value('uuid') : null;

        return [
            'uuid' => PublicId::encode('lifecycle_event', $e->id),
            'from_state' => $e->from_state,
            'to_state' => $e->to_state,
            'reason' => $e->reason,
            'actor' => $e->actor_user_id !== null ? self::userRef(User::query()->find($e->actor_user_id)) : null,
            'job_uuid' => is_string($job) ? $job : null,
            'at' => $e->at->toIso8601String(),
        ];
    }

    /** @return array{uuid: string, code: string, name: string, version: int} */
    public static function packageRef(HostingPackage $p, HostingPackageVersion $v): array
    {
        return ['uuid' => $p->uuid, 'code' => $p->code, 'name' => $p->name, 'version' => $v->version];
    }

    /** @return array{uuid: string, name: string, email: string} */
    public static function userRef(?User $u): array
    {
        return $u instanceof User ? ['uuid' => $u->uuid, 'name' => $u->name, 'email' => $u->email]
            : ['uuid' => '00000000-0000-4000-8000-000000000000', 'name' => 'Hệ thống', 'email' => 'system@itso.local'];
    }

    /** @param  array<array-key, mixed>  $versionIds */
    private static function accountCount(array $versionIds): int
    {
        return DB::table('hosting_accounts')->whereIn('package_version_id', $versionIds ?: [0])->whereNull('deleted_at')
            ->whereNotIn('lifecycle_state', ['purged'])->count();
    }
}
