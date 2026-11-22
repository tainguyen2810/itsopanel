<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

/**
 * Danh mục sự kiện thông báo ở code (ADR 0049 §1): nhóm, mức mặc định, đối tượng nhận, kênh cho phép, in_app_locked.
 * Kênh `telegram`/`webhook` là kênh realm admin; USER chỉ có in_app + email.
 * Loại không có trong danh mục (thông báo cũ, vd. migration.*) chỉ gửi in-app, không có tùy chọn.
 */
final class NotificationCatalog
{
    public const PERSONAL = ['in_app', 'email', 'telegram'];

    public const PORTAL_CHANNELS = ['in_app', 'email'];

    /**
     * Khớp danh mục của bản demo (contracts/tools/demo.py). Kênh là kênh cá nhân người nhận chọn được; webhook/email nhóm
     * gắn theo rule cảnh báo, không nằm trong tùy chọn cá nhân.
     *
     * @var array<string, array{group: string, severity: string, audiences: list<string>, channels: list<string>}>
     */
    public const EVENTS = [
        'alert.firing' => ['group' => 'monitoring', 'severity' => 'high', 'audiences' => self::ADMINS, 'channels' => ['in_app', 'email', 'telegram']],
        'alert.resolved' => ['group' => 'monitoring', 'severity' => 'info', 'audiences' => self::ADMINS, 'channels' => ['in_app', 'email']],
        'server.unreachable' => ['group' => 'monitoring', 'severity' => 'critical', 'audiences' => self::ADMINS, 'channels' => ['in_app', 'email', 'telegram']],
        'website.down' => ['group' => 'monitoring', 'severity' => 'high', 'audiences' => self::ALL, 'channels' => ['in_app', 'email']],
        'website.up' => ['group' => 'monitoring', 'severity' => 'info', 'audiences' => self::ALL, 'channels' => ['in_app']],
        'quota.warning' => ['group' => 'account', 'severity' => 'medium', 'audiences' => self::ALL, 'channels' => ['in_app', 'email']],
        'quota.exceeded' => ['group' => 'account', 'severity' => 'high', 'audiences' => self::ALL, 'channels' => ['in_app', 'email']],
        'account.suspended' => ['group' => 'account', 'severity' => 'high', 'audiences' => self::ALL, 'channels' => ['in_app', 'email']],
        'account.unsuspended' => ['group' => 'account', 'severity' => 'info', 'audiences' => ['user'], 'channels' => ['in_app', 'email']],
        'certificate.expiring' => ['group' => 'ssl', 'severity' => 'medium', 'audiences' => self::ALL, 'channels' => ['in_app', 'email']],
        'certificate.renew_failed' => ['group' => 'ssl', 'severity' => 'high', 'audiences' => self::ALL, 'channels' => ['in_app', 'email']],
        'backup.failed' => ['group' => 'backup', 'severity' => 'high', 'audiences' => self::ALL, 'channels' => ['in_app', 'email']],
        'backup.succeeded' => ['group' => 'backup', 'severity' => 'info', 'audiences' => self::ADMINS, 'channels' => ['in_app']],
        'job.failed' => ['group' => 'jobs', 'severity' => 'medium', 'audiences' => self::ALL, 'channels' => ['in_app']],
        'security.high' => ['group' => 'security', 'severity' => 'critical', 'audiences' => self::ADMINS, 'channels' => ['in_app', 'email', 'telegram']],
        'wordpress.rolled_back' => ['group' => 'wordpress', 'severity' => 'high', 'audiences' => self::ALL, 'channels' => ['in_app', 'email']],
    ];

    private const ADMINS = ['super_admin', 'admin'];

    private const ALL = ['super_admin', 'admin', 'user'];

    /** Loại thông báo cụ thể → khóa danh mục. */
    public static function key(string $type): ?string
    {
        if (isset(self::EVENTS[$type])) {
            return $type;
        }

        return match (true) {
            $type === 'alert.repeat' => 'alert.firing',
            str_starts_with($type, 'security.') => 'security.high',
            str_starts_with($type, 'wordpress.update_') => 'wordpress.rolled_back',
            default => null,
        };
    }

    /** @return array{group: string, severity: string, audiences: list<string>, channels: list<string>}|null */
    public static function find(string $type): ?array
    {
        $k = self::key($type);

        return $k === null ? null : self::EVENTS[$k];
    }

    /** Mức critical: in-app luôn bật (D-104). */
    public static function inAppLocked(string $key): bool
    {
        return (self::EVENTS[$key]['severity'] ?? '') === 'critical';
    }

    /**
     * Danh mục theo realm (portal: chỉ sự kiện có `user`, kênh in_app + email).
     *
     * @return list<array{type: string, group: string, severity: string, audiences: list<string>, channels: list<string>, in_app_locked: bool}>
     */
    public static function list(bool $portal): array
    {
        $out = [];
        foreach (self::EVENTS as $type => $e) {
            if ($portal && ! in_array('user', $e['audiences'], true)) {
                continue;
            }
            $out[] = ['type' => $type, 'group' => $e['group'], 'severity' => $e['severity'], 'audiences' => $e['audiences'],
                'channels' => $portal ? array_values(array_intersect($e['channels'], self::PORTAL_CHANNELS)) : $e['channels'],
                'in_app_locked' => self::inAppLocked($type)];
        }

        return $out;
    }
}
