<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Domain\Data\DataSpec;
use App\Domain\Data\FileService;
use App\Models\CronJob;
use App\Models\CronRun;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\HostingAccount;
use App\Models\Server;
use App\Models\SftpAccount;
use App\Models\SshKey;
use App\Models\UploadSession;
use App\Models\Website;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/** Trình bày Database, DatabaseUser, SftpAccount, SshKey, CronJob, CronRun, UploadSession theo common.yaml. */
final class DataPresenter
{
    /** @return array<string, mixed> */
    public static function database(Database $d): array
    {
        $users = isset(self::$pre['grants']) ? self::$pre['grants'][$d->id] ?? []
            : DB::table('database_grants')->join('database_users', 'database_users.id', '=', 'database_grants.database_user_id')
                ->where('database_grants.database_id', $d->id)->whereNull('database_users.deleted_at')->orderBy('database_users.username')
                ->pluck('database_users.username')->map(fn ($u): string => (string) $u)->all();
        /** @var Server $s */
        $s = self::$pre['servers'][$d->server_id] ?? Server::query()->findOrFail($d->server_id);

        return ['uuid' => $d->uuid, 'hosting_account' => self::acct($d), 'server' => ['uuid' => $s->uuid, 'name' => $s->name],
            'engine' => $d->engine, 'name' => $d->name, 'size_mb' => (float) ($d->size_mb ?? 0), 'charset' => $d->charset,
            'users' => $users] + self::state($d);
    }

    /** @return array<string, mixed> */
    public static function databaseUser(DatabaseUser $u): array
    {
        return ['uuid' => $u->uuid, 'hosting_account' => self::acct($u), 'engine' => $u->engine, 'username' => $u->username,
            'host' => $u->host_pattern, 'max_connections' => $u->max_connections, 'grants' => DataSpec::grants($u)] + self::state($u);
    }

    /** @return array<string, mixed> */
    public static function sftp(SftpAccount $s): array
    {
        return ['uuid' => $s->uuid, 'hosting_account' => self::acct($s), 'username' => $s->username, 'protocol' => $s->protocol,
            'root_path' => $s->root_subpath === '' ? '.' : $s->root_subpath, 'read_only' => $s->read_only,
            'last_login_at' => $s->last_login_at?->toIso8601String()] + self::state($s);
    }

    /** @return array<string, mixed> */
    public static function sshKey(SshKey $k): array
    {
        return ['uuid' => $k->uuid, 'hosting_account' => self::acct($k), 'name' => $k->name, 'fingerprint' => $k->fingerprint,
            'type' => $k->type, 'last_used_at' => $k->last_used_at?->toIso8601String(),
            'created_at' => $k->created_at->toIso8601String(), 'updated_at' => $k->updated_at->toIso8601String()];
    }

    /** @return array<string, mixed> */
    public static function cron(CronJob $c): array
    {
        $w = $c->website_id !== null ? Website::withTrashed()->find($c->website_id) : null;

        return ['uuid' => $c->uuid, 'hosting_account' => self::acct($c),
            'website' => $w instanceof Website ? ['uuid' => $w->uuid, 'primary_domain' => $w->primary_domain] : null,
            'schedule' => $c->schedule, 'command' => $c->command, 'working_dir' => $c->working_dir, 'php_version' => $c->php_version,
            'enabled' => $c->enabled, 'timeout_sec' => $c->timeout_sec, 'last_run_at' => $c->last_run_at?->toIso8601String(),
            'last_status' => $c->last_status] + self::state($c);
    }

    /** @return array<string, mixed> */
    public static function cronRun(CronRun $r): array
    {
        return ['uuid' => $r->uuid, 'started_at' => $r->started_at->toIso8601String(), 'finished_at' => $r->finished_at?->toIso8601String(),
            'exit_code' => $r->exit_code, 'status' => $r->status, 'output_tail' => (string) ($r->output_tail ?? '')];
    }

    /** @return array<string, mixed> */
    public static function upload(UploadSession $u): array
    {
        $job = $u->job_id !== null ? DB::table('jobs')->where('id', $u->job_id)->value('uuid') : null;

        return ['uuid' => $u->uuid, 'path' => $u->target_path, 'size' => $u->size_bytes, 'chunk_size' => FileService::CHUNK,
            'received' => $u->received_bytes, 'expires_at' => $u->expires_at->toIso8601String(), 'status' => $u->status,
            'job_uuid' => is_string($job) ? $job : null];
    }

    public static function etag(Model $m): string
    {
        return '"d-'.$m->getAttribute('spec_version').'-'.$m->getAttribute('updated_at')?->getTimestamp().'"';
    }

    /** @var array{accounts?: array<int, HostingAccount>, servers?: array<int, Server>, grants?: array<int, list<string>>} */
    private static array $pre = [];

    /**
     * Nạp trước account, server, user được cấp quyền cho cả trang danh sách (Prompt 12.5, chặn N+1). Trả hàm dọn cache tĩnh
     * (Listing::page gọi sau khi trình bày xong).
     *
     * @param  list<Model>  $models
     */
    public static function prefetch(array $models): \Closure
    {
        $ids = fn (string $k): array => array_values(array_unique(array_filter(array_map(fn (Model $m): ?int => $m->getAttribute($k), $models)))) ?: [0];
        self::$pre = ['accounts' => HostingAccount::withTrashed()->whereIn('id', $ids('hosting_account_id'))->get()->keyBy('id')->all()];
        if ($models !== [] && $models[0] instanceof Database) {
            self::$pre['servers'] = Server::query()->whereIn('id', $ids('server_id'))->get()->keyBy('id')->all();
            $grants = [];
            foreach (DB::table('database_grants')->join('database_users', 'database_users.id', '=', 'database_grants.database_user_id')
                ->whereIn('database_grants.database_id', $ids('id'))->whereNull('database_users.deleted_at')->orderBy('database_users.username')
                ->get(['database_grants.database_id', 'database_users.username']) as $r) {
                $grants[(int) $r->database_id][] = (string) $r->username;
            }
            self::$pre['grants'] = $grants;
        }

        return function (): void {
            self::$pre = [];
        };
    }

    /** @return array{uuid: string, username: string} */
    private static function acct(Model $m): array
    {
        /** @var HostingAccount $a */
        $a = self::$pre['accounts'][(int) $m->getAttribute('hosting_account_id')]
            ?? HostingAccount::withTrashed()->findOrFail($m->getAttribute('hosting_account_id'));

        return ['uuid' => $a->uuid, 'username' => $a->username];
    }

    /** @return array<string, mixed> */
    private static function state(Database|DatabaseUser|SftpAccount|CronJob $m): array
    {
        $drift = is_array($m->drift) && $m->drift !== [] ? array_map(fn ($v): string => is_string($v) ? $v : (string) json_encode($v), $m->drift) : null;

        return ['status' => $m->status, 'spec_version' => $m->spec_version, 'observed_version' => $m->observed_version, 'drift' => $drift,
            'observed_at' => $m->observed_at?->toIso8601String(), 'created_at' => $m->created_at->toIso8601String(),
            'updated_at' => $m->updated_at->toIso8601String()];
    }
}
