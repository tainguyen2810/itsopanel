<?php

declare(strict_types=1);

namespace App\Domain\Data;

use App\Domain\Hosting\QuotaService;
use App\Domain\Jobs\Secrets;
use App\Exceptions\ApiProblem;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

/**
 * Database hosting (Prompt 6.3, D-71): quota database_limit/db_user_limit theo gói (đếm trong khóa FOR UPDATE), tiền tố
 * `<username>_`, mật khẩu sinh/đổi lưu mã hóa (job chỉ mang tham chiếu bí mật), import/export qua job chạy dưới uid account.
 */
final class DatabaseService
{
    public const PRIVILEGES = ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX'];

    public function __construct(private readonly DataJobs $jobs, private readonly QuotaService $quota) {}

    /**
     * @param  array<string, mixed>  $in  DatabaseCreate
     * @return array{0: Database, 1: Job, 2: string|null} database, job, mật khẩu sinh một lần (create_user)
     */
    public function create(User $actor, HostingAccount $a, array $in): array
    {
        $engine = DataSpec::engine((string) $in['engine']);
        $name = DataSpec::prefixed($a, $in['name'] ?? null, 'name', $engine === 'postgresql' ? 63 : 64);
        $withUser = (bool) ($in['create_user'] ?? false);
        $secret = $withUser ? DataSpec::password() : null;
        /** @var DatabaseUser|null $user */
        $user = null;
        [$db, $job] = $this->jobs->run($actor, $a, 'database.create', function (HostingAccount $acc) use ($engine, $name, $withUser, $secret, &$user): array {
            $this->quota->ensureCanAdd($acc, 'databases');
            $this->ensureFree($acc, $engine, $name);
            $db = Database::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id, 'engine' => $engine,
                'name' => $name, 'charset' => $engine === 'postgresql' ? 'UTF8' : 'utf8mb4', 'status' => 'provisioning', 'size_mb' => 0]);
            $spec = DataJobs::spec('database.create', $db, $acc)
                ->step(DataSpec::op($engine, 'owner_ensure'), ['account' => DataSpec::acct($acc)])
                ->step(DataSpec::op($engine, 'create'), ['account' => DataSpec::acct($acc), 'name' => $name, 'charset' => $db->charset]);
            if ($withUser) {
                $this->ensureUserQuota($acc);
                $this->ensureUserFree($acc, $engine, $name);
                $user = DatabaseUser::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id, 'engine' => $engine,
                    'username' => $name, 'password_encrypted' => Crypt::encryptString((string) $secret), 'host_pattern' => 'localhost',
                    'max_connections' => 10, 'status' => 'provisioning']);
                DB::table('database_grants')->insert(['database_id' => $db->id, 'database_user_id' => $user->id,
                    'privileges' => DataSpec::toPgArray(['ALL'])]);
                $spec->step(DataSpec::op($engine, 'user_ensure'), $this->userParams($user, $acc, true))
                    ->step(DataSpec::op($engine, 'grant'), ['account' => DataSpec::acct($acc), 'username' => $name, 'database' => $name,
                        'privileges' => ['ALL']]);
                $db->observed_facts = ['created_user_id' => $user->id];
                $db->save();
            }

            return [$db, $spec, ['engine' => $engine, 'name' => $name, 'create_user' => $withUser]];
        }, true, function (Job $job) use (&$user): void {
            if ($user instanceof DatabaseUser) {
                DatabaseUser::query()->whereKey($user->id)->update(['last_job_id' => $job->id]);
            }
        });

        /** @var Database $db */
        return [$db, $job, $secret];
    }

    public function delete(User $actor, Database $db): Job
    {
        DataJobs::ensureIdle($db);
        [, $job] = $this->jobs->run($actor, $db->account, 'database.delete', function (HostingAccount $acc) use ($db): array {
            /** @var Database $d */
            $d = Database::query()->lockForUpdate()->findOrFail($db->id);
            $d->status = 'deleting';
            $d->save();
            $spec = DataJobs::spec('database.delete', $d, $acc)
                ->step(DataSpec::op($d->engine, 'drop'), ['account' => DataSpec::acct($acc), 'name' => $d->name, 'confirm_name' => $d->name]);

            return [$d, $spec, ['name' => $d->name]];
        }, false);

        return $job;
    }

    /** Xuất DB ra file `backups/<tên>-<thời điểm>.sql.gz` trong home (helper dưới uid account). */
    public function export(User $actor, Database $db): Job
    {
        $this->ready($db);
        $target = 'backups/'.$db->name.'-'.Carbon::now()->format('Ymd-His').'.sql.gz';
        [, $job] = $this->jobs->run($actor, $db->account, 'database.export', function (HostingAccount $acc) use ($db, $target): array {
            $spec = DataJobs::spec('database.export', $db, $acc, 3600)
                ->step('fs.mkdir', ['account' => DataSpec::acct($acc), 'path' => 'backups', 'mode' => '0750'])
                ->step(DataSpec::op($db->engine, 'dump'), ['account' => DataSpec::acct($acc), 'name' => $db->name, 'target' => $target,
                    'compress' => true]);

            return [$db, $spec, ['target' => $target]];
        });

        return $job;
    }

    public function import(User $actor, Database $db, string $path): Job
    {
        $this->ready($db);
        $path = DataSpec::relPath($path, 'path', false);
        [, $job] = $this->jobs->run($actor, $db->account, 'database.import', function (HostingAccount $acc) use ($db, $path): array {
            $spec = DataJobs::spec('database.import', $db, $acc, 3600)
                ->step(DataSpec::op($db->engine, 'import'), ['account' => DataSpec::acct($acc), 'name' => $db->name, 'source' => $path]);

            return [$db, $spec, ['source' => $path]];
        });

        return $job;
    }

    /**
     * @param  array<string, mixed>  $in  DatabaseUserCreate
     * @return array{0: DatabaseUser, 1: Job, 2: string|null}
     */
    public function createUser(User $actor, HostingAccount $a, array $in): array
    {
        $engine = DataSpec::engine((string) $in['engine']);
        $name = DataSpec::prefixed($a, $in['username'] ?? null, 'username', $engine === 'postgresql' ? 63 : 64);
        $given = $in['password'] ?? null;
        $secret = $given === null ? DataSpec::password() : DataSpec::checkPassword($given);
        $host = (string) ($in['host'] ?? 'localhost');
        if ($engine === 'postgresql' && $host !== 'localhost') {
            throw ApiProblem::field('host', 'PostgreSQL chỉ nhận kết nối localhost (pg_hba theo D-71).');
        }
        $maxConn = (int) ($in['max_connections'] ?? 10);
        [$u, $job] = $this->jobs->run($actor, $a, 'database_user.create', function (HostingAccount $acc) use ($engine, $name, $secret, $host, $maxConn): array {
            $this->ensureUserQuota($acc);
            $this->ensureUserFree($acc, $engine, $name);
            $u = DatabaseUser::query()->create(['hosting_account_id' => $acc->id, 'server_id' => $acc->server_id, 'engine' => $engine,
                'username' => $name, 'password_encrypted' => Crypt::encryptString($secret), 'host_pattern' => $host,
                'max_connections' => $maxConn, 'status' => 'provisioning']);
            $spec = DataJobs::spec('database_user.create', $u, $acc)
                ->step(DataSpec::op($engine, 'owner_ensure'), ['account' => DataSpec::acct($acc)])
                ->step(DataSpec::op($engine, 'user_ensure'), $this->userParams($u, $acc, true));

            return [$u, $spec, ['username' => $name, 'engine' => $engine, 'host' => $host, 'max_connections' => $maxConn]];
        });

        /** @var DatabaseUser $u */
        return [$u, $job, $given === null ? $secret : null];
    }

    public function deleteUser(User $actor, DatabaseUser $u): Job
    {
        DataJobs::ensureIdle($u);
        [, $job] = $this->jobs->run($actor, $u->account, 'database_user.delete', function (HostingAccount $acc) use ($u): array {
            $u->status = 'deleting';
            $u->save();
            $spec = DataJobs::spec('database_user.delete', $u, $acc)
                ->step(DataSpec::op($u->engine, 'user_drop'), ['account' => DataSpec::acct($acc), 'username' => $u->username]);

            return [$u, $spec, ['username' => $u->username]];
        }, false);

        return $job;
    }

    /** @param  list<array{database: string, privileges: list<string>}>  $grants */
    public function setGrants(User $actor, DatabaseUser $u, array $grants): Job
    {
        $this->ready($u);
        $want = [];
        foreach ($grants as $i => $g) {
            $db = Database::query()->where('hosting_account_id', $u->hosting_account_id)->where('engine', $u->engine)
                ->where('name', $g['database'])->whereNot('status', 'deleting')->first();
            if (! $db instanceof Database) {
                throw ApiProblem::field("grants.$i.database", 'Database không thuộc account hoặc khác engine với user.');
            }
            $privs = array_values(array_unique(array_map('strval', $g['privileges'])));
            if (in_array('ALL', $privs, true)) {
                $privs = ['ALL'];
            }
            sort($privs);
            $want[$db->id] = ['db' => $db, 'privs' => $privs];
        }
        $old = DB::table('database_grants')->where('database_user_id', $u->id)->pluck('privileges', 'database_id')->all();
        [, $job] = $this->jobs->run($actor, $u->account, 'database_user.grants', function (HostingAccount $acc) use ($u, $want, $old): array {
            $spec = DataJobs::spec('database_user.grants', $u, $acc);
            $changes = [];
            $ids = array_unique(array_merge(array_keys($want), array_map('intval', array_keys($old))));
            foreach ($ids as $dbId) {
                $privs = $want[$dbId]['privs'] ?? [];
                $before = isset($old[$dbId]) ? DataSpec::pgArray((string) $old[$dbId]) : [];
                sort($before);
                if ($privs === $before) {
                    continue;
                }
                $db = $want[$dbId]['db'] ?? Database::withTrashed()->find($dbId);
                if (! $db instanceof Database) {
                    continue;
                }
                $changes[$db->name] = ['from' => $before, 'to' => $privs];
                if ($privs === []) {
                    DB::table('database_grants')->where('database_user_id', $u->id)->where('database_id', $dbId)->delete();
                } else {
                    DB::table('database_grants')->updateOrInsert(['database_id' => $dbId, 'database_user_id' => $u->id],
                        ['privileges' => DataSpec::toPgArray($privs)]);
                }
                if ($db->trashed()) {
                    continue;
                }
                $spec->step(DataSpec::op($u->engine, 'grant'), ['account' => DataSpec::acct($acc), 'username' => $u->username,
                    'database' => $db->name, 'privileges' => $privs]);
            }
            if ($spec->steps === []) {
                throw new ApiProblem(409, 'conflict', 'Không có thay đổi', 'Quyền gửi lên giống quyền hiện tại.');
            }
            $u->spec_version++;
            $u->save();

            return [$u, $spec, $changes];
        });

        return $job;
    }

    /** @return array{0: Job, 1: string} job đổi mật khẩu và mật khẩu mới (trả một lần) */
    public function rotatePassword(User $actor, DatabaseUser $u): array
    {
        $this->ready($u);
        $secret = DataSpec::password();
        [, $job] = $this->jobs->run($actor, $u->account, 'database_user.rotate_password', function (HostingAccount $acc) use ($u, $secret): array {
            $u->password_encrypted = Crypt::encryptString($secret);
            $u->spec_version++;
            $u->save();
            $spec = DataJobs::spec('database_user.rotate_password', $u, $acc)
                ->step(DataSpec::op($u->engine, 'user_ensure'), $this->userParams($u, $acc, true));

            return [$u, $spec, ['password' => 'rotated']];
        });

        return [$job, $secret];
    }

    /** @return array<string, mixed> */
    public function userParams(DatabaseUser $u, HostingAccount $a, bool $withPassword): array
    {
        return ['account' => DataSpec::acct($a), 'username' => $u->username,
            'password' => $withPassword ? Secrets::ref('db_user_password', $u->uuid) : null,
            'host' => $u->host_pattern, 'max_connections' => $u->max_connections];
    }

    private function ready(Database|DatabaseUser $m): void
    {
        if (! in_array($m->status, ['ready', 'degraded'], true)) {
            throw new ApiProblem(409, 'invalid_state_transition', 'Tài nguyên chưa sẵn sàng', "Trạng thái hiện tại: {$m->status}.");
        }
        DataJobs::ensureIdle($m);
    }

    private function ensureFree(HostingAccount $a, string $engine, string $name): void
    {
        if (Database::query()->where('server_id', $a->server_id)->where('engine', $engine)->where('name', $name)->exists()) {
            throw new ApiProblem(409, 'conflict', 'Tên database đã tồn tại', "Đã có database $name trên server.");
        }
    }

    private function ensureUserFree(HostingAccount $a, string $engine, string $name): void
    {
        if (DatabaseUser::query()->where('server_id', $a->server_id)->where('engine', $engine)->where('username', $name)->exists()) {
            throw new ApiProblem(409, 'conflict', 'Tên DB user đã tồn tại', "Đã có DB user $name trên server.");
        }
    }

    private function ensureUserQuota(HostingAccount $a): void
    {
        $limit = (int) ($this->quota->limits($a)['db_user_limit'] ?? 0);
        $used = DatabaseUser::query()->where('hosting_account_id', $a->id)->count();
        if ($used + 1 > $limit) {
            throw QuotaService::exceeded('db_users', "Đã dùng $used/$limit DB user theo gói.");
        }
    }
}
