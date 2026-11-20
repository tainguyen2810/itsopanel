<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Auth\Realm;
use App\Models\HostingAccount;
use App\Models\HostingPackage;
use App\Models\Job;
use App\Models\JobLog;
use App\Models\JobStep;
use App\Models\Server;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;

/** Job / JobLog theo contracts/openapi/common.yaml. */
final class JobPresenter
{
    /** @var array<string, class-string<Model>> loại tài nguyên công khai → model có cột uuid */
    public const RESOURCE_MODELS = [
        'hosting_account' => HostingAccount::class,
        'server' => Server::class,
        'user' => User::class,
        'hosting_package' => HostingPackage::class,
    ];

    /** @return array{type: string, uuid: string}|null */
    public static function resource(?string $type, ?int $id): ?array
    {
        if ($type === null || $id === null || ! isset(self::RESOURCE_MODELS[$type])) {
            return null;
        }
        $uuid = (self::RESOURCE_MODELS[$type])::query()->whereKey($id)->value('uuid');

        return is_string($uuid) ? ['type' => $type, 'uuid' => $uuid] : null;
    }

    /** @return array<string, mixed> */
    public function job(Job $j, string $realm): array
    {
        $steps = JobStep::query()->where('job_id', $j->id)->orderBy('seq')->get();
        $server = $j->server_id !== null ? Server::query()->find($j->server_id) : null;
        $by = $j->requested_by_user_id !== null ? User::query()->find($j->requested_by_user_id) : null;
        $failedStep = $j->error_code !== null ? $steps->firstWhere('state', 'failed') : null;
        $base = '/api/v1/'.($realm === Realm::ADMIN ? 'admin' : 'portal').'/jobs/'.$j->uuid;

        return [
            'uuid' => $j->uuid,
            'type' => $j->type,
            'state' => $j->state,
            'progress' => (int) $j->progress,
            'resource' => self::resource($j->resource_type, $j->resource_id),
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
