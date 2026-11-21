<?php

declare(strict_types=1);

namespace App\Domain\Jobs;

use App\Models\Certificate;
use App\Models\DatabaseUser;
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

    private function value(string $ref): string
    {
        [$kind, $uuid] = array_pad(explode(':', $ref, 2), 2, '');
        if ($kind === 'certificate_key' && Str::isUuid($uuid)) {
            $c = Certificate::query()->where('uuid', $uuid)->first();
            if ($c instanceof Certificate && is_string($c->private_key_encrypted) && $c->private_key_encrypted !== '') {
                return Crypt::decryptString($c->private_key_encrypted);
            }
        }
        // Mật khẩu DB user / FTP-SFTP (D-71, D-73): lưu mã hóa trong panel, chỉ giải ngay trước khi gửi agent.
        $model = match ($kind) {
            'db_user_password' => DatabaseUser::class,
            'sftp_password' => SftpAccount::class,
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
