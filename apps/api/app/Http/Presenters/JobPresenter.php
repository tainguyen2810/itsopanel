<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Auth\Realm;
use App\Models\AccountMigration;
use App\Models\Certificate;
use App\Models\ComposeProject;
use App\Models\CronJob;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\DnsZone;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\Job;
use App\Models\JobLog;
use App\Models\JobStep;
use App\Models\MalwareFinding;
use App\Models\PanelImport;
use App\Models\QuarantineItem;
use App\Models\Registry;
use App\Models\Server;
use App\Models\SftpAccount;
use App\Models\SshKey;
use App\Models\User;
use App\Models\Website;
use App\Models\WordPressSite;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Collection;

/** Job / JobLog theo contracts/openapi/common.yaml. */
final class JobPresenter
{
    /** @var array<string, class-string<Model>> loại tài nguyên công khai → model có cột uuid */
    public const RESOURCE_MODELS = [
        'hosting_account' => HostingAccount::class,
        'server' => Server::class,
        'user' => User::class,
        'hosting_package' => HostingPackage::class,
        'website' => Website::class,
        'certificate' => Certificate::class,
        'dns_zone' => DnsZone::class,
        'database' => Database::class,
        'database_user' => DatabaseUser::class,
        'sftp_account' => SftpAccount::class,
        'ssh_key' => SshKey::class,
        'cron_job' => CronJob::class,
        'malware_finding' => MalwareFinding::class,
        'quarantine_item' => QuarantineItem::class,
        'account_migration' => AccountMigration::class,
        'compose_project' => ComposeProject::class,
        'registry' => Registry::class,
        'wordpress_site' => WordPressSite::class,
        'import' => PanelImport::class,
    ];

    /** @return array{type: string, uuid: string}|null */
    public static function resource(?string $type, ?int $id): ?array
    {
        if ($type === null || $id === null || ! isset(self::RESOURCE_MODELS[$type])) {
            return null;
        }
        $m = self::RESOURCE_MODELS[$type];
        // Tài nguyên đã xóa mềm (website sau website.delete) vẫn hiện trong lịch sử job.
        $q = in_array(SoftDeletes::class, class_uses_recursive($m), true) ? $m::withTrashed() : $m::query();
        $uuid = $q->whereKey($id)->value('uuid');

        return is_string($uuid) ? ['type' => $type, 'uuid' => $uuid] : null;
    }

    /** @var array{steps: array<int, Collection<int, JobStep>>, servers: array<int, Server|null>, users: array<int, User|null>, res: array<string, array<int, string>>}|null */
    private ?array $pre = null;

    /**
     * Nạp trước bước, server, người yêu cầu, uuid tài nguyên cho cả trang danh sách (Prompt 12.5, chặn N+1).
     *
     * @param  list<Job>  $jobs
     */
    public function prefetch(array $jobs): void
    {
        $ids = array_map(fn (Job $j): int => $j->id, $jobs);
        $steps = JobStep::query()->whereIn('job_id', $ids ?: [0])->orderBy('seq')->get()->groupBy('job_id');
        $sids = array_values(array_unique(array_filter(array_map(fn (Job $j): ?int => $j->server_id, $jobs))));
        $uids = array_values(array_unique(array_filter(array_map(fn (Job $j): ?int => $j->requested_by_user_id, $jobs))));
        $servers = Server::query()->whereIn('id', $sids ?: [0])->get()->keyBy('id');
        $users = User::query()->whereIn('id', $uids ?: [0])->get()->keyBy('id');
        $res = [];
        foreach (collect($jobs)->filter(fn (Job $j): bool => $j->resource_id !== null && isset(self::RESOURCE_MODELS[(string) $j->resource_type]))
            ->groupBy('resource_type') as $type => $group) {
            $m = self::RESOURCE_MODELS[$type];
            $q = in_array(SoftDeletes::class, class_uses_recursive($m), true) ? $m::withTrashed() : $m::query();
            $res[$type] = $q->whereIn('id', $group->pluck('resource_id')->unique()->values()->all())->pluck('uuid', 'id')->all();
        }
        $this->pre = ['steps' => [], 'servers' => [], 'users' => [], 'res' => $res];
        foreach ($jobs as $j) {
            $this->pre['steps'][$j->id] = $steps->get($j->id) ?? collect();
            if ($j->server_id !== null) {
                $this->pre['servers'][$j->server_id] = $servers->get($j->server_id);
            }
            if ($j->requested_by_user_id !== null) {
                $this->pre['users'][$j->requested_by_user_id] = $users->get($j->requested_by_user_id);
            }
        }
    }

    /** @return array<string, mixed> */
    public function job(Job $j, string $realm): array
    {
        $pre = $this->pre !== null && isset($this->pre['steps'][$j->id]) ? $this->pre : null;
        $steps = $pre !== null ? $pre['steps'][$j->id] : JobStep::query()->where('job_id', $j->id)->orderBy('seq')->get();
        $server = $j->server_id === null ? null
            : ($pre !== null ? $pre['servers'][$j->server_id] ?? null : Server::query()->find($j->server_id));
        $by = $j->requested_by_user_id === null ? null
            : ($pre !== null ? $pre['users'][$j->requested_by_user_id] ?? null : User::query()->find($j->requested_by_user_id));
        $resource = $pre !== null && $j->resource_id !== null && isset($pre['res'][(string) $j->resource_type])
            ? (isset($pre['res'][$j->resource_type][$j->resource_id]) ? ['type' => (string) $j->resource_type, 'uuid' => (string) $pre['res'][$j->resource_type][$j->resource_id]] : null)
            : self::resource($j->resource_type, $j->resource_id);
        $failedStep = $j->error_code !== null ? $steps->firstWhere('state', 'failed') : null;
        $base = '/api/v1/'.($realm === Realm::ADMIN ? 'admin' : 'portal').'/jobs/'.$j->uuid;

        return [
            'uuid' => $j->uuid,
            'type' => $j->type,
            'state' => $j->state,
            'progress' => (int) $j->progress,
            'resource' => $resource,
            'steps' => $steps->map(fn (JobStep $s): array => [
                'seq' => $s->seq, 'op' => $s->op, 'state' => $s->state,
                'started_at' => $s->started_at?->toIso8601String(), 'finished_at' => $s->finished_at?->toIso8601String(),
            ])->values()->all(),
            'attempts' => (int) $j->attempts,
            'max_attempts' => max(1, (int) $j->max_attempts),
            'timeout_sec' => max(1, (int) $j->timeout_sec),
            'error' => $j->error_code !== null && in_array($j->state, ['failed', 'timed_out', 'cancelled', 'queued'], true)
                ? ['code' => $j->error_code, 'message' => (string) $j->error_message, 'step' => $failedStep?->seq]
                : null,
            'server' => $server instanceof Server ? ['uuid' => $server->uuid, 'name' => $server->name] : null,
            'requested_by' => $by instanceof User ? ['uuid' => $by->uuid, 'name' => $by->name, 'email' => $by->email] : null,
            'created_at' => $j->created_at->toIso8601String(),
            'started_at' => $j->started_at?->toIso8601String(),
            'finished_at' => $j->finished_at?->toIso8601String(),
            'links' => ['self' => $base, 'events' => $base.'/events'],
        ];
    }

    /** @return array{seq: int, at: string, level: string, message: string} */
    public static function log(JobLog $l): array
    {
        return ['seq' => $l->id, 'at' => $l->at->toIso8601String(), 'level' => $l->level, 'message' => $l->message];
    }
}
