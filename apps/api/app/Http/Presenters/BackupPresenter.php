<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Domain\Backup\BackupService;
use App\Domain\Backup\PolicyService;
use App\Domain\Hosting\QuotaService;
use App\Models\BackupDestination;
use App\Models\BackupPolicy;
use App\Models\BackupRepository;
use App\Models\BackupSnapshot;
use App\Models\BackupVerification;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\PurgeRecord;
use App\Models\RestoreJob;
use App\Models\Server;
use App\Models\User;
use App\Models\Website;
use Illuminate\Support\Carbon;

/** Backup / khôi phục theo contracts (Prompt 8.4). Không bao giờ trả credential hay mật khẩu repo (trừ bộ khôi phục). */
final class BackupPresenter
{
    /** @return array{uuid: string, username: string}|null */
    public static function accountRef(?int $id): ?array
    {
        $a = $id !== null ? HostingAccount::withTrashed()->find($id) : null;

        return $a instanceof HostingAccount ? ['uuid' => $a->uuid, 'username' => $a->username] : null;
    }

    private static function mb(int|float|null $bytes): float
    {
        return round(((float) ($bytes ?? 0)) / 1048576, 1);
    }

    /** @return array<string, mixed> */
    public static function destination(BackupDestination $d): array
    {
        $size = (int) BackupRepository::query()->where('destination_id', $d->id)->sum('size_bytes');

        return ['uuid' => $d->uuid, 'name' => $d->name, 'type' => $d->type, 'hosting_account' => null, 'append_only' => $d->append_only,
            'immutable_days' => $d->immutable_days, 'config' => (object) $d->config, 'used_mb' => self::mb($size),
            'last_check_at' => $d->last_check_at?->toIso8601String(), 'last_check_ok' => $d->last_check_ok, 'last_check_error' => $d->last_check_error,
            'detected' => $d->detected !== null ? (object) $d->detected : null, 'ssh_public_key' => $d->ssh_public_key,
            'host_key_sha256' => $d->host_key_sha256, 'repositories' => BackupRepository::query()->where('destination_id', $d->id)->count(),
            'prune' => $d->immutable() ? 'cli' : 'panel', 'recovery_kit_acknowledged_at' => $d->recovery_kit_acknowledged_at?->toIso8601String(),
            'created_at' => $d->created_at->toIso8601String(), 'updated_at' => $d->updated_at->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function policy(BackupPolicy $p): array
    {
        $dests = $p->destinations()->get();

        return ['uuid' => $p->uuid, 'name' => $p->name, 'scope_type' => $p->scope_type, 'scope_uuid' => PolicyService::scopeUuid($p),
            'contents' => $p->contents, 'volume_consistency' => $p->volume_consistency, 'excludes' => $p->excludes, 'schedule' => $p->schedule,
            'destination_uuids' => $dests->pluck('uuid')->values()->all(), 'retention' => (object) $p->retention,
            'retention_mode' => $dests->contains(fn (BackupDestination $d) => $d->immutable()) ? 'cli' : 'panel', 'enabled' => $p->enabled,
            'last_run_at' => $p->last_run_at?->toIso8601String(), 'next_run_at' => $p->next_run_at?->toIso8601String(),
            'last_status' => $p->last_status, 'created_at' => $p->created_at->toIso8601String(), 'updated_at' => $p->updated_at->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function repository(BackupRepository $r): array
    {
        $d = $r->destination;
        $s = $r->server;

        return ['uuid' => $r->uuid, 'destination' => ['uuid' => $d->uuid, 'name' => $d->name, 'type' => $d->type], 'scope_type' => $r->scope_type,
            'hosting_account' => self::accountRef($r->hosting_account_id), 'server' => ['uuid' => $s->uuid, 'name' => $s->name], 'path' => $r->path,
            'size_mb' => self::mb($r->size_bytes), 'snapshots' => $r->snapshots_count, 'last_snapshot_at' => $r->last_snapshot_at?->toIso8601String(),
            'last_check_at' => $r->last_check_at?->toIso8601String(), 'last_check_ok' => $r->last_check_ok, 'quota_state' => $r->quota_state];
    }

    /** @return array<string, mixed> */
    public static function snapshot(BackupSnapshot $s): array
    {
        $d = $s->destination;
        $w = $s->website_id !== null ? Website::withTrashed()->find($s->website_id) : null;

        return ['uuid' => $s->uuid, 'hosting_account' => self::accountRef($s->hosting_account_id), 'destination' => ['uuid' => $d->uuid, 'name' => $d->name],
            'repository_uuid' => BackupRepository::withTrashed()->whereKey($s->repository_id)->value('uuid'), 'scope_type' => $s->scope_type,
            'website' => $w instanceof Website ? ['uuid' => $w->uuid, 'primary_domain' => $w->primary_domain] : null, 'databases' => $s->databases,
            'volumes' => [], 'restic_snapshot_id' => $s->restic_snapshot_id, 'size_mb' => self::mb($s->size_bytes), 'taken_at' => $s->taken_at->toIso8601String(),
            'verified_at' => $s->verified_at?->toIso8601String(), 'contents' => $s->contents, 'tags' => $s->tags, 'panel_version' => $s->panel_version,
            'locked_until' => $s->locked_until?->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function verification(BackupVerification $v): array
    {
        $d = BackupDestination::withTrashed()->findOrFail($v->destination_id);

        return ['uuid' => $v->uuid, 'kind' => $v->kind, 'destination' => ['uuid' => $d->uuid, 'name' => $d->name],
            'hosting_account' => self::accountRef($v->hosting_account_id),
            'snapshot_uuid' => $v->snapshot_id !== null ? BackupSnapshot::query()->whereKey($v->snapshot_id)->value('uuid') : null,
            'state' => $v->state, 'read_data_percent' => $v->read_data_percent, 'files_checked' => $v->files_checked, 'mismatches' => $v->mismatches,
            'error' => $v->error, 'started_at' => $v->started_at->toIso8601String(), 'finished_at' => $v->finished_at?->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function restore(RestoreJob $r): array
    {
        $job = $r->job_id !== null ? Job::query()->find($r->job_id) : null;
        $srv = $r->target_server_id !== null ? Server::query()->find($r->target_server_id) : null;
        $res = $r->result;

        return ['uuid' => $r->uuid, 'snapshot_uuid' => $r->snapshot_id !== null ? BackupSnapshot::query()->whereKey($r->snapshot_id)->value('uuid') : null,
            'hosting_account' => self::accountRef($r->hosting_account_id), 'target_server' => ['uuid' => (string) $srv?->uuid, 'name' => (string) $srv?->name],
            'mode' => $r->mode, 'items' => $r->items, 'state' => $job->state ?? $r->status, 'job_uuid' => $job?->uuid,
            'requested_by' => HostingPresenter::userRef(User::query()->find($r->requested_by_user_id)),
            'created_at' => $r->created_at->toIso8601String(), 'finished_at' => $r->finished_at?->toIso8601String(),
            'result' => is_array($res) ? ['restored_paths' => array_values((array) ($res['restored_paths'] ?? [])),
                'databases' => array_values((array) ($res['databases'] ?? [])),
                'pre_restore_snapshot_uuid' => $r->pre_restore_snapshot_id !== null
                    ? BackupSnapshot::query()->whereKey($r->pre_restore_snapshot_id)->value('uuid') : null] : null,
            'error' => $r->error];
    }

    /** @return array<string, mixed> */
    public static function purge(PurgeRecord $p): array
    {
        return ['uuid' => $p->uuid, 'hosting_account' => self::accountRef($p->hosting_account_id),
            'requested_by' => HostingPresenter::userRef(User::query()->find($p->requested_by_user_id)),
            'confirmed_by' => $p->confirmed_by_user_id !== null ? HostingPresenter::userRef(User::query()->find($p->confirmed_by_user_id)) : null,
            'final_backup_snapshot_uuid' => $p->final_backup_snapshot_id !== null
                ? BackupSnapshot::query()->whereKey($p->final_backup_snapshot_id)->value('uuid') : null,
            'backup_verified_at' => $p->backup_verified_at?->toIso8601String(), 'scheduled_for' => $p->scheduled_for->toIso8601String(),
            'completed_at' => $p->completed_at?->toIso8601String(), 'objects' => $p->objects,
            'created_at' => $p->created_at->toIso8601String(), 'updated_at' => $p->updated_at->toIso8601String()];
    }

    /**
     * Tổng quan 3-2-1-1-0: ≥ 3 bản (gốc + 2 đích), 2 loại phương tiện, 1 ngoài máy, 1 bất biến, 0 lỗi kiểm chứng (30 ngày).
     *
     * @return array<string, mixed>
     */
    public static function overview(BackupService $svc, QuotaService $quota): array
    {
        $dests = BackupDestination::query()->where('enabled', true)->orderBy('id')->get();
        $copies = $dests->count() + 1;
        $media = $dests->map(fn (BackupDestination $d) => $d->type === 'local' ? 'local' : 'remote:'.$d->type)->unique()->count();
        $offsite = $dests->where('type', '!=', 'local')->count();
        $immutable = $dests->filter(fn (BackupDestination $d) => $d->immutable())->count();
        $since = Carbon::now()->subDays(30);
        $errors = BackupVerification::query()->where('state', 'failed')->where('started_at', '>=', $since)->count()
            + BackupDestination::query()->where('enabled', true)->where('last_check_ok', false)->count();
        $rule = fn (string $k, bool $ok, int $v, string $why) => ['key' => $k, 'ok' => $ok, 'value' => $v, 'reason' => $ok ? null : $why];
        $running = Job::query()->whereIn('type', BackupService::JOB_TYPES)->whereIn('state', ['queued', 'running'])->orderBy('id')->limit(20)->get()
            ->map(function (Job $j): array {
                $label = match ($j->resource_type) {
                    'hosting_account' => HostingAccount::withTrashed()->whereKey($j->resource_id)->value('username'),
                    'server' => Server::query()->whereKey($j->resource_id)->value('name'),
                    default => null,
                };

                return ['job_uuid' => $j->uuid, 'type' => $j->type, 'label' => is_string($label) ? $label : $j->type, 'progress' => (int) $j->progress,
                    'started_at' => ($j->started_at ?? $j->created_at)->toIso8601String()];
            })->values()->all();
        $quotaRows = [];
        // Tính lại theo gói hiện tại (gói/override có thể đổi sau lần stats cuối).
        $accIds = BackupRepository::query()->whereNotNull('hosting_account_id')->where('size_bytes', '>', 0)->pluck('hosting_account_id')->unique();
        foreach (HostingAccount::query()->whereIn('id', $accIds)->orderBy('username')->get() as $a) {
            $state = $svc->quotaState($a);
            if ($state !== 'ok') {
                $quotaRows[] = ['hosting_account' => ['uuid' => $a->uuid, 'username' => $a->username], 'used_mb' => $svc->usedMb($a),
                    'limit_mb' => (float) ($quota->limits($a)['backup_quota_mb'] ?? 0), 'state' => $state];
            }
        }

        return [
            'rules' => [
                $rule('copies', $copies >= 3, $copies, 'Cần ít nhất 2 đích backup (dữ liệu gốc + 2 bản).'),
                $rule('media', $media >= 2, $media, 'Cần 2 loại phương tiện lưu trữ khác nhau.'),
                $rule('offsite', $offsite >= 1, $offsite, 'Cần ít nhất 1 đích ngoài máy chủ (SFTP/S3/REST).'),
                $rule('immutable', $immutable >= 1, $immutable, 'Cần ít nhất 1 đích bất biến (append-only hoặc Object Lock).'),
                $rule('errors', $errors === 0, $errors, 'Có lỗi kiểm chứng/kiểm tra đích trong 30 ngày qua.'),
            ],
            'last_backup_at' => self::ts(BackupSnapshot::query()->max('taken_at')),
            'last_verified_at' => self::ts(BackupSnapshot::query()->max('verified_at')),
            'failed_24h' => Job::query()->whereIn('type', BackupService::JOB_TYPES)->whereIn('state', ['failed', 'timed_out'])
                ->where('finished_at', '>=', Carbon::now()->subDay())->count(),
            'destinations' => $dests->map(fn (BackupDestination $d): array => ['uuid' => $d->uuid, 'name' => $d->name, 'type' => $d->type,
                'used_mb' => self::mb((int) BackupRepository::query()->where('destination_id', $d->id)->sum('size_bytes')),
                'immutable' => $d->immutable(), 'last_check_ok' => $d->last_check_ok])->values()->all(),
            'running' => $running,
            'quota' => $quotaRows,
        ];
    }

    private static function ts(mixed $v): ?string
    {
        return $v !== null ? Carbon::parse((string) $v)->toIso8601String() : null;
    }

    public static function etag(BackupDestination|BackupPolicy $m): string
    {
        return '"b-'.$m->id.'-'.$m->updated_at->getTimestamp().'"';
    }
}
