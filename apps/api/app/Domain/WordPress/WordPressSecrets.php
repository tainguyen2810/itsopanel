<?php

declare(strict_types=1);

namespace App\Domain\WordPress;

use App\Domain\Jobs\Secrets;
use App\Models\Job;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Mật khẩu một lần của WordPress (admin khi cài, đổi mật khẩu admin): không lưu trong DB panel, chỉ giữ tạm trong Cache
 * (Crypt) để JobRunner thay vào params ngay trước khi gửi agent; xóa khi job kết thúc (D-69).
 */
final class WordPressSecrets
{
    public const KIND = 'wp_password';

    public const TTL = 7200;

    /** @return array{'$secret': string} */
    public static function put(string $plain): array
    {
        $id = (string) Str::uuid();
        Cache::put(self::key($id), Crypt::encryptString($plain), self::TTL);

        return Secrets::ref(self::KIND, $id);
    }

    public static function get(string $id): ?string
    {
        $enc = Str::isUuid($id) ? Cache::get(self::key($id)) : null;

        return is_string($enc) ? Crypt::decryptString($enc) : null;
    }

    /** Xóa mọi mật khẩu tạm mà các bước của job tham chiếu. */
    public static function forget(Job $job): void
    {
        foreach (DB::table('job_steps')->where('job_id', $job->id)->pluck('params_redacted') as $raw) {
            $json = is_string($raw) ? $raw : (string) json_encode($raw);
            if (preg_match_all('/"'.preg_quote(self::KIND, '/').':([0-9a-f-]{36})"/', $json, $m) > 0) {
                foreach ($m[1] as $id) {
                    Cache::forget(self::key($id));
                }
            }
        }
    }

    private static function key(string $id): string
    {
        return 'wp-secret:'.$id;
    }
}
