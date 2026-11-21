<?php

declare(strict_types=1);

namespace App\Auth;

use Illuminate\Support\Carbon;

/**
 * Một dòng cho mỗi lần đăng nhập sai để jail fail2ban `itso-panel` đọc (ADR 0024 §4):
 * `<ISO8601> itso-auth failed ip=<IP>`. Chỉ IP (đã kiểm hợp lệ), không ghi email/mật khẩu. Ghi file bằng PHP,
 * không gọi lệnh hệ thống; thư mục không tồn tại (máy dev) → bỏ qua.
 */
final class AuthFailureLog
{
    public static function failed(string $ip): void
    {
        if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
            return;
        }
        $path = (string) config('itso.security.auth_log', '');
        if ($path === '' || ! is_dir(dirname($path)) || (file_exists($path) && ! is_writable($path))) {
            return;
        }
        @file_put_contents($path, Carbon::now()->utc()->format('Y-m-d\TH:i:s\Z').' itso-auth failed ip='.$ip."\n", FILE_APPEND | LOCK_EX);
    }
}
