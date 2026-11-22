<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Models\Server;
use App\Models\Setting;

/**
 * Cập nhật bảo mật tự động của hệ điều hành theo server (D-100): lưu ở `settings` (group `os_updates`, key = uuid server).
 * Không bao giờ tự reboot: `auto_reboot` luôn false.
 */
final class OsUpdates
{
    /** @return array{enabled: bool, security_only: bool, auto_reboot: false, pending_security: int, last_run_at: string|null, updated_at: string} */
    public static function get(Server $s): array
    {
        $row = Setting::query()->where('group_key', 'os_updates')->where('key', $s->uuid)->first();
        $v = $row instanceof Setting ? (array) $row->value : [];

        return ['enabled' => (bool) ($v['enabled'] ?? false), 'security_only' => (bool) ($v['security_only'] ?? true),
            'auto_reboot' => false, 'pending_security' => (int) ($v['pending_security'] ?? 0),
            'last_run_at' => is_string($v['last_run_at'] ?? null) ? $v['last_run_at'] : null,
            'updated_at' => ($row->updated_at ?? $s->created_at)->toIso8601String()];
    }

    /** @param  array<string, mixed>  $v */
    public static function put(Server $s, array $v, ?int $userId = null): void
    {
        $row = Setting::query()->firstOrNew(['group_key' => 'os_updates', 'key' => $s->uuid]);
        $row->value = ['enabled' => (bool) ($v['enabled'] ?? false), 'security_only' => (bool) ($v['security_only'] ?? true),
            'pending_security' => (int) ($v['pending_security'] ?? 0), 'last_run_at' => $v['last_run_at'] ?? null];
        $row->is_encrypted = false;
        if ($userId !== null) {
            $row->updated_by_user_id = $userId;
        }
        $row->save();
    }
}
