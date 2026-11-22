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

    /** @var array<string, array{group: string, severity: string, audiences: list<string>, channels: list<string>}> */
    public const EVENTS = [
        'alert.firing' => ['group' => 'monitoring', 'severity' => 'high', 'audiences' => ['super_admin', 'admin'],
            'channels' => ['in_app', 'email', 'telegram', 'webhook']],
        'alert.resolved' => ['group' => 'monitoring', 'severity' => 'info', 'audiences' => ['super_admin', 'admin'],
            'channels' => ['in_app', 'email', 'telegram', 'webhook']],
        'server.unreachable' => ['group' => 'monitoring', 'severity' => 'critical', 'audiences' => ['super_admin', 'admin'],
            'channels' => ['in_app', 'email', 'telegram']],
        'website.down' => ['group' => 'monitoring', 'severity' => 'high', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email', 'telegram']],
        'website.up' => ['group' => 'monitoring', 'severity' => 'info', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email', 'telegram']],
        'quota.warning' => ['group' => 'account', 'severity' => 'medium', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email']],
        'quota.exceeded' => ['group' => 'account', 'severity' => 'high', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email', 'telegram']],
        'account.suspended' => ['group' => 'account', 'severity' => 'high', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email']],
        'account.unsuspended' => ['group' => 'account', 'severity' => 'info', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email']],
        'certificate.expiring' => ['group' => 'ssl', 'severity' => 'medium', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email', 'telegram']],
        'certificate.renew_failed' => ['group' => 'ssl', 'severity' => 'high', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email', 'telegram']],
        'backup.failed' => ['group' => 'backup', 'severity' => 'high', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email', 'telegram']],
        'job.failed' => ['group' => 'jobs', 'severity' => 'medium', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email']],
        'security.high' => ['group' => 'security', 'severity' => 'critical', 'audiences' => ['super_admin', 'admin'],
            'channels' => ['in_app', 'email', 'telegram']],
        'wordpress.rolled_back' => ['group' => 'wordpress', 'severity' => 'high', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email']],
        'wordpress.update_failed' => ['group' => 'wordpress', 'severity' => 'high', 'audiences' => ['super_admin', 'admin', 'user'],
            'channels' => ['in_app', 'email']],
    ];

    /** Loại thông báo cụ thể → khóa danh mục. */
    public static function key(string $type): ?string
    {
        if (isset(self::EVENTS[$type])) {
            return $type;
        }

        return match (true) {
            $type === 'alert.repeat' => 'alert.firing',
            str_starts_with($type, 'security.') => 'security.high',
            $type === 'wordpress.update_rolled_back' => 'wordpress.rolled_back',
            $type === 'wordpress.update_failed' => 'wordpress.update_failed',
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
