<?php

declare(strict_types=1);

namespace App\Domain\Jobs;

use App\Domain\Backup\DisasterRecovery;
use App\Models\BackupDestination;
use App\Models\BackupRepository;
use App\Models\Certificate;
use App\Models\ComposeProject;
use App\Models\DatabaseUser;
use App\Models\Registry;
use App\Models\SftpAccount;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Str;

/**
 * Tham chiếu bí mật trong params job (D-69): bước lưu `{"$secret": "<loại>:<uuid>"}`; JobRunner chỉ thay bằng giá trị
 * thật ngay trước khi gửi agent, không ghi lại vào job_steps, job_logs hay audit.
 */
final class Secrets
{
    public const KEY = '$secret';

    /** @return array{'$secret': string} */
    public static function ref(string $kind, string $uuid): array
    {
        return [self::KEY => $kind.':'.$uuid];
    }

    public static function isRef(mixed $v): bool
    {
        return is_array($v) && count($v) === 1 && is_string($v[self::KEY] ?? null);
    }

    /**
     * @param  array<array-key, mixed>  $params
     * @return array<array-key, mixed>
     */
    public function resolve(array $params): array
    {
        foreach ($params as $k => $v) {
            if (self::isRef($v)) {
                $params[$k] = $this->value((string) $v[self::KEY]);
            } elseif (is_array($v)) {
                $params[$k] = $this->resolve($v);
            }
        }

        return $params;
    }

    /** @return string|array<string, string>|\stdClass */
    private function value(string $ref): string|array|\stdClass
    {
        [$kind, $uuid] = array_pad(explode(':', $ref, 2), 2, '');
        // Docker (D-98): mật khẩu registry; biến môi trường compose (JSON Crypt) → object `env` của compose.apply.
        if ($kind === 'compose_env' && Str::isUuid($uuid)) {
            $p = ComposeProject::withTrashed()->where('uuid', $uuid)->first();
            if ($p instanceof ComposeProject) {
                $env = is_string($p->env_encrypted) && $p->env_encrypted !== ''
                    ? json_decode(Crypt::decryptString($p->env_encrypted), true) : [];
                $env = is_array($env) ? array_map('strval', $env) : [];

                return $env === [] ? new \stdClass : $env;
            }
        }
        if ($kind === 'certificate_key' && Str::isUuid($uuid)) {
            $c = Certificate::query()->where('uuid', $uuid)->first();
            if ($c instanceof Certificate && is_string($c->private_key_encrypted) && $c->private_key_encrypted !== '') {
                return Crypt::decryptString($c->private_key_encrypted);
            }
        }
        // Backup (ADR 0029 §4): mật khẩu repo restic; credential ghi của đích `backup_dest_credential:<uuid>/<khóa>`.
        if ($kind === 'backup_repo_password' && Str::isUuid($uuid)) {
            $enc = BackupRepository::withTrashed()->where('uuid', $uuid)->first()?->password_encrypted;
            if (is_string($enc) && $enc !== '') {
                return Crypt::decryptString($enc);
            }
        }
        if ($kind === 'backup_dest_credential' && preg_match('#^([0-9a-f-]{36})/([a-z_]{1,40})$#', $uuid, $m) === 1) {
            $d = BackupDestination::withTrashed()->where('uuid', $m[1])->first();
            if ($d instanceof BackupDestination && is_string($d->credentials_encrypted) && $d->credentials_encrypted !== '') {
                $creds = json_decode(Crypt::decryptString($d->credentials_encrypted), true);
                if (is_array($creds) && is_string($creds[$m[2]] ?? null)) {
                    return $creds[$m[2]];
                }
            }
        }
        // Khôi phục thảm họa (D-87): bí mật tạm của wizard trong Cache (Crypt), xóa khi job setup.restore xong.
        if ($kind === DisasterRecovery::SECRET_KIND && ($v = DisasterRecovery::secret($uuid)) !== null) {
            return $v;
        }
        // Mật khẩu DB user / FTP-SFTP (D-71, D-73): lưu mã hóa trong panel, chỉ giải ngay trước khi gửi agent.
        $model = match ($kind) {
            'db_user_password' => DatabaseUser::class,
            'sftp_password' => SftpAccount::class,
            'registry_password' => Registry::class,
            default => null,
        };
        if ($model !== null && Str::isUuid($uuid)) {
            $enc = $model::withTrashed()->where('uuid', $uuid)->first()?->password_encrypted;
            if (is_string($enc) && $enc !== '') {
                return Crypt::decryptString($enc);
            }
        }
        throw new PanelStepFailed('internal', "Không giải được tham chiếu bí mật $kind (đã xóa hoặc sai loại).");
    }
}
