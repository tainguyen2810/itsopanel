<?php

declare(strict_types=1);

namespace App\Domain\Data;

use App\Domain\Hosting\ProvisioningService;
use App\Domain\Jobs\JobSpec;
use App\Domain\Jobs\Secrets;
use App\Exceptions\ApiProblem;
use App\Models\CronJob;
use App\Models\Database;
use App\Models\DatabaseUser;
use App\Models\HostingAccount;
use App\Models\SftpAccount;
use Illuminate\Support\Facades\DB;

/**
 * Dựng params op agent cho dữ liệu hosting (Phase 6) và kiểm tham số dùng chung: đường dẫn tương đối, tên có tiền tố,
 * mật khẩu. Mật khẩu chỉ đi vào job dưới dạng tham chiếu bí mật (D-69).
 */
final class DataSpec
{
    /** Bộ ký tự SecretPassword (common.yaml): không nháy, gạch chéo ngược, khoảng trắng. */
    public const PASSWORD_RE = '/^[A-Za-z0-9._~!@#%^*+=:,-]{12,128}$/';

    public const ENGINES = ['mariadb' => 'mysql', 'mysql' => 'mysql', 'postgresql' => 'pg'];

    /** Tiền tố op agent: db.mysql.* hoặc db.pg.* */
    public static function op(string $engine, string $action): string
    {
        return 'db.'.(self::ENGINES[$engine] ?? 'mysql').'.'.$action;
    }

    /** mysql là bí danh của mariadb (Ubuntu 24.04 cài MariaDB 10.11). */
    public static function engine(string $engine): string
    {
        return $engine === 'postgresql' ? 'postgresql' : 'mariadb';
    }

    public static function password(): string
    {
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789._-+=';
        $out = '';
        for ($i = 0; $i < 24; $i++) {
            $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }

        return $out;
    }

    public static function checkPassword(mixed $pw, string $field = 'password'): string
    {
        if (! is_string($pw) || preg_match(self::PASSWORD_RE, $pw) !== 1) {
            throw ApiProblem::field($field, 'Mật khẩu 12–128 ký tự, không có dấu nháy, gạch chéo ngược hay khoảng trắng.');
        }

        return $pw;
    }

    /** Tên DB/DB user/FTP: chữ thường, số, gạch dưới; bắt buộc tiền tố `<username>_`. */
    public static function prefixed(HostingAccount $a, mixed $name, string $field, int $max = 64): string
    {
        $n = is_string($name) ? $name : '';
        $reserved = ['mysql', 'information_schema', 'performance_schema', 'sys', 'postgres', 'template0', 'template1', 'root'];
        if (preg_match('/^[a-z][a-z0-9_]*$/', $n) !== 1 || strlen($n) > $max || in_array($n, $reserved, true)
            || ! str_starts_with($n, $a->username.'_') || strlen($n) === strlen($a->username) + 1) {
            throw ApiProblem::field($field, "Tên phải có dạng {$a->username}_<tên> (chữ thường, số, gạch dưới; tối đa $max ký tự).");
        }

        return $n;
    }

    /** Đường dẫn tương đối với home (RelPath): `.` = home; cấm tuyệt đối, `..`, ký tự điều khiển. */
    public static function relPath(mixed $p, string $field = 'path', bool $allowRoot = true): string
    {
        $s = is_string($p) ? $p : '';
        if ($s === '.' && $allowRoot) {
            return '.';
        }
        $ok = $s !== '' && strlen($s) <= 4096 && ! str_starts_with($s, '/') && ! str_ends_with($s, '/')
            && preg_match('/[\x00-\x1f\x7f]/', $s) !== 1 && mb_check_encoding($s, 'UTF-8');
        foreach (explode('/', $s) as $seg) {
            $ok = $ok && $seg !== '' && $seg !== '.' && $seg !== '..' && strlen($seg) <= 255;
        }
        if (! $ok) {
            throw ApiProblem::field($field, 'Đường dẫn phải tương đối với thư mục home (không có .., /, ký tự điều khiển).');
        }

        return $s;
    }

    /** @return array<string, mixed> */
    public static function acct(HostingAccount $a): array
    {
        return ProvisioningService::ref($a);
    }

    /** @return list<array<string, mixed>> entries cron.apply theo desired state (khóa account → tắt hết) */
    public static function cronEntries(HostingAccount $a, ?bool $suspended = null, ?int $exclude = null): array
    {
        $suspended ??= $a->lifecycle_state !== 'active';
        $out = [];
        $q = CronJob::query()->where('hosting_account_id', $a->id)->whereNot('status', 'deleting')->orderBy('id');
        if ($exclude !== null) {
            $q->whereKeyNot($exclude);
        }
        foreach ($q->get() as $c) {
            $out[] = ['uuid' => $c->uuid, 'schedule' => $c->schedule, 'command' => $c->command, 'working_dir' => $c->working_dir,
                'enabled' => $c->enabled && ! $suspended, 'timeout_sec' => $c->timeout_sec];
        }

        return $out;
    }

    /** @return array<string, mixed> params ftp.user.ensure */
    public static function ftpUser(SftpAccount $s, HostingAccount $a, ?bool $enabled = null): array
    {
        $enabled ??= $a->lifecycle_state === 'active';

        return ['account' => self::acct($a), 'username' => $s->username, 'root_path' => $s->root_subpath === '' ? '.' : $s->root_subpath,
            'enabled' => $enabled, 'password' => $enabled && $s->password_encrypted !== null ? Secrets::ref('sftp_password', $s->uuid) : null];
    }

    /** @return array<string, mixed> params sftp.user.ensure (password null = giữ nguyên) */
    public static function sftpUser(SftpAccount $s, HostingAccount $a, bool $sshAllowed, bool $withPassword): array
    {
        return ['account' => self::acct($a), 'ssh_access' => $sshAllowed,
            'password' => $withPassword && $s->password_encrypted !== null ? Secrets::ref('sftp_password', $s->uuid) : null];
    }

    /** @return list<string> */
    public static function sshKeys(HostingAccount $a): array
    {
        $keys = DB::table('ssh_keys')->where('hosting_account_id', $a->id)->orderBy('id')->pluck('public_key')->map(fn ($k): string => (string) $k)->all();

        return array_values($keys);
    }

    /** @return list<array{database: string, privileges: list<string>}> */
    public static function grants(DatabaseUser $u): array
    {
        $rows = DB::table('database_grants')->join('databases', 'databases.id', '=', 'database_grants.database_id')
            ->where('database_user_id', $u->id)->whereNull('databases.deleted_at')->orderBy('databases.name')
            ->get(['databases.name', 'database_grants.privileges'])
            ->map(fn ($r): array => ['database' => (string) $r->name, 'privileges' => self::pgArray((string) $r->privileges)])->all();

        return array_values($rows);
    }

    /** @return list<string> */
    public static function pgArray(string $v): array
    {
        $v = trim($v, '{}');

        return $v === '' ? [] : array_map(fn (string $x): string => trim($x, '"'), explode(',', $v));
    }

    /** @param  list<string>  $privs */
    public static function toPgArray(array $privs): string
    {
        return '{'.implode(',', $privs).'}';
    }

    /**
     * Áp lại trạng thái dữ liệu theo trạng thái account (tạm khóa / mở khóa / chấm dứt / đồng bộ): khóa đăng nhập DB,
     * tắt/bật cron, khóa/mở FTP phụ (mật khẩu thật đặt lại từ bản mã hóa). SFTP chính bị chặn bởi DenyGroups itso-suspended.
     */
    public static function reapplyAccount(JobSpec $spec, HostingAccount $a, bool $suspended): JobSpec
    {
        foreach (array_keys(self::ENGINES) as $engine) {
            if ($engine === 'mysql') {
                continue;
            }
            $has = Database::query()->where('hosting_account_id', $a->id)->where('engine', $engine)->exists()
                || DatabaseUser::query()->where('hosting_account_id', $a->id)->where('engine', $engine)->exists();
            if ($has) {
                $spec->step(self::op($engine, 'lock'), ['account' => self::acct($a), 'locked' => $suspended]);
            }
        }
        if (CronJob::query()->where('hosting_account_id', $a->id)->exists()) {
            $spec->step('cron.apply', ['account' => self::acct($a), 'entries' => self::cronEntries($a, $suspended)]);
        }
        foreach (SftpAccount::query()->where('hosting_account_id', $a->id)->where('protocol', 'ftps')
            ->whereNotIn('status', ['deleting', 'failed'])->orderBy('id')->get() as $f) {
            $spec->step('ftp.user.ensure', self::ftpUser($f, $a, ! $suspended));
        }

        return $spec;
    }
}
