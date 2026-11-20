<?php

declare(strict_types=1);

namespace App\Support;

/**
 * UUID công khai cho bảng không có cột uuid (api_tokens, notifications, audit_logs, impersonation_sessions):
 * 16 hex đầu = HMAC(APP_KEY, loại:id) (không đoán được), 12 hex cuối = id → giải ngược được, kiểm HMAC khi đọc.
 * Không lộ id tuần tự ra ngoài dưới dạng số và không giả mạo được id khác.
 */
final class PublicId
{
    public static function encode(string $kind, int $id): string
    {
        $h = self::mac($kind, $id);

        return sprintf('%s-%s-8%s-%s-%012x', substr($h, 0, 8), substr($h, 8, 4), substr($h, 12, 3), '8'.substr($h, 15, 3), $id);
    }

    public static function decode(string $kind, string $uuid): ?int
    {
        $uuid = strtolower($uuid);
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-([0-9a-f]{12})$/', $uuid, $m) !== 1) {
            return null;
        }
        $id = (int) hexdec($m[1]);

        return $id > 0 && hash_equals(self::encode($kind, $id), $uuid) ? $id : null;
    }

    private static function mac(string $kind, int $id): string
    {
        return hash_hmac('sha256', $kind.':'.$id, (string) config('app.key'));
    }
}
