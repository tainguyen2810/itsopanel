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
        $v = HostingPackageVersion::query()->findOrFail($a->package_version_id);
        $p = HostingPackage::query()->withTrashed()->findOrFail($v->package_id);
        $server = Server::query()->withTrashed()->findOrFail($a->server_id);

        return [
            'uuid' => $a->uuid,
            'username' => $a->username,
            'server' => ['uuid' => $server->uuid, 'name' => $server->name],
            'package' => self::packageRef($p, $v),
            'owner' => self::userRef(User::query()->find($a->owner_user_id)),
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
