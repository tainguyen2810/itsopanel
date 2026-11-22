<?php

declare(strict_types=1);

namespace App\Domain\Backup;

use App\Domain\Audit\AuditLogger;
use App\Domain\Data\CronSchedule;
use App\Exceptions\ApiProblem;
use App\Models\BackupDestination;
use App\Models\BackupPolicy;
use App\Models\ComposeProject;
use App\Models\Database;
use App\Models\HostingAccount;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use Cron\CronExpression;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** Chính sách backup (D-86): phạm vi, nội dung, lịch cron, đích (3-2-1), retention mong muốn. */
final class PolicyService
{
    public const SCOPES = ['all_accounts', 'hosting_account', 'website', 'database', 'server', 'panel', 'compose_project'];

    public const RETENTION_KEYS = ['last', 'hourly', 'daily', 'weekly', 'monthly'];

    public function __construct(private readonly AuditLogger $audit) {}

    /** @param  array<string, mixed>  $in */
    public function create(User $actor, array $in): BackupPolicy
    {
        $attrs = $this->attributes($in, null);

        return DB::transaction(function () use ($actor, $attrs): BackupPolicy {
            $dests = $attrs['_dests'];
            unset($attrs['_dests']);
            $p = BackupPolicy::query()->create($attrs);
            $p->destinations()->sync($dests);
            $this->audit->record('backup_policy.create', $p, ['name' => $p->name, 'scope_type' => $p->scope_type, 'schedule' => $p->schedule],
                'success', null, null, $actor);

            return $p->refresh();
        });
    }

    /** @param  array<string, mixed>  $in */
    public function update(User $actor, BackupPolicy $p, array $in): BackupPolicy
    {
        $attrs = $this->attributes($in, $p);

        return DB::transaction(function () use ($actor, $p, $attrs, $in): BackupPolicy {
            $dests = $attrs['_dests'];
            unset($attrs['_dests']);
            $p->fill($attrs)->save();
            $p->destinations()->sync($dests);
            $this->audit->record('backup_policy.update', $p, array_intersect_key($in, array_flip(['name', 'scope_type', 'scope_uuid', 'contents',
                'excludes', 'schedule', 'destination_uuids', 'retention', 'enabled'])), 'success', null, null, $actor);

            return $p->refresh();
        });
    }

    public function delete(User $actor, BackupPolicy $p): void
    {
        $p->delete();
        $this->audit->record('backup_policy.delete', $p, ['name' => $p->name], 'success', null, null, $actor);
    }

    /**
     * @param  array<string, mixed>  $in
     * @return array<string, mixed>
     */
    private function attributes(array $in, ?BackupPolicy $p): array
    {
        $scope = (string) ($in['scope_type'] ?? $p?->scope_type);
        $scopeUuid = array_key_exists('scope_uuid', $in) ? $in['scope_uuid'] : ($p !== null && array_key_exists('scope_type', $in) && $in['scope_type'] !== $p->scope_type
            ? null : self::scopeUuid($p));
        $scopeId = null;
        if (in_array($scope, ['all_accounts', 'panel'], true)) {
            if ($scopeUuid !== null) {
                throw ApiProblem::field('scope_uuid', "Phạm vi $scope không nhận scope_uuid.");
            }
        } else {
            $model = match ($scope) {
                'hosting_account' => HostingAccount::class, 'website' => Website::class, 'database' => Database::class,
                'compose_project' => ComposeProject::class, default => Server::class,
            };
            $id = is_string($scopeUuid) && Str::isUuid($scopeUuid) ? $model::query()->where('uuid', $scopeUuid)->value('id') : null;
            if ($id === null) {
                throw ApiProblem::field('scope_uuid', 'Không tìm thấy đối tượng của phạm vi.');
            }
            $scopeId = (int) $id;
        }
        $contents = array_values(array_unique(array_map('strval', (array) ($in['contents'] ?? $p->contents ?? ['files', 'databases']))));
        $allowed = match ($scope) {
            'server' => [['config']], 'panel' => [['config'], []], 'database' => [['databases']],
            'compose_project' => [['docker_volumes']],
            default => [['files'], ['databases'], ['files', 'databases'], ['databases', 'files']],
        };
        if (! in_array($contents, $allowed, true)) {
            throw ApiProblem::field('contents', match ($scope) {
                'server' => 'Phạm vi server chỉ backup cấu hình (config).',
                'panel' => 'Phạm vi panel: dump DB panel + /etc/itso (để contents trống hoặc config).',
                'database' => 'Phạm vi database chỉ có databases.',
                'compose_project' => 'Phạm vi compose project chỉ backup volume Docker (docker_volumes).',
                default => 'Account/website: files và/hoặc databases.',
            });
        }
        $consistency = (string) ($in['volume_consistency'] ?? $p->volume_consistency ?? 'pause');
        if (! in_array($consistency, ['pause', 'none'], true)) {
            throw ApiProblem::field('volume_consistency', 'pause (dừng tạm container khi chụp) hoặc none.');
        }
        if ($scope === 'website' && $contents !== ['files']) {
            throw ApiProblem::field('contents', 'Phạm vi website chỉ backup files của website (DB backup theo phạm vi database).');
        }
        $excludes = array_values(array_map('strval', (array) ($in['excludes'] ?? $p->excludes ?? [])));
        foreach ($excludes as $i => $e) {
            if (preg_match('#^[A-Za-z0-9._*?/@+-]{1,200}$#', $e) !== 1 || preg_match('#(^|/)\.\.(/|$)|^/#', $e) === 1) {
                throw ApiProblem::field("excludes.$i", 'Mẫu loại trừ tương đối, không "..", ký tự an toàn.');
            }
        }
        $schedule = (string) ($in['schedule'] ?? $p?->schedule);
        CronSchedule::parse($schedule);
        $dests = $in['destination_uuids'] ?? null;
        $destIds = $dests === null && $p !== null ? $p->destinations()->pluck('backup_destinations.id')->all() : [];
        if ($dests !== null) {
            foreach (array_values((array) $dests) as $i => $u) {
                $id = is_string($u) && Str::isUuid($u) ? BackupDestination::query()->where('uuid', $u)->value('id') : null;
                if ($id === null) {
                    throw ApiProblem::field("destination_uuids.$i", 'Không tìm thấy đích.');
                }
                $destIds[] = (int) $id;
            }
        }
        if ($destIds === []) {
            throw ApiProblem::field('destination_uuids', 'Cần ít nhất một đích.');
        }
        $retention = (array) ($in['retention'] ?? $p->retention ?? []);
        foreach ($retention as $k => $v) {
            if (! in_array($k, self::RETENTION_KEYS, true) || ! is_int($v) || $v < 0 || $v > 1000) {
                throw ApiProblem::field("retention.$k", 'retention: last|hourly|daily|weekly|monthly, số nguyên 0–1000.');
            }
        }
        $enabled = (bool) ($in['enabled'] ?? $p->enabled ?? true);

        return ['name' => trim((string) ($in['name'] ?? $p?->name)), 'scope_type' => $scope, 'scope_id' => $scopeId,
            'contents' => $scope === 'panel' ? ['config'] : $contents, 'excludes' => $excludes, 'schedule' => $schedule, 'retention' => $retention,
            'volume_consistency' => $consistency, 'enabled' => $enabled, 'next_run_at' => $enabled ? self::next($schedule, Carbon::now()) : null, '_dests' => array_values(array_unique($destIds))];
    }

    public static function next(string $schedule, Carbon $after): Carbon
    {
        return Carbon::instance((new CronExpression($schedule))->getNextRunDate($after->copy()->setTimezone(config('app.timezone'))));
    }

    public static function scopeUuid(?BackupPolicy $p): ?string
    {
        if ($p === null || $p->scope_id === null) {
            return null;
        }
        $model = match ($p->scope_type) {
            'hosting_account' => HostingAccount::class, 'website' => Website::class, 'database' => Database::class, 'server' => Server::class,
            'compose_project' => ComposeProject::class, default => null,
        };
        $uuid = $model !== null ? $model::withTrashed()->whereKey($p->scope_id)->value('uuid') : null;

        return is_string($uuid) ? $uuid : null;
    }
}
