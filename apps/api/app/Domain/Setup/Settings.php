<?php

declare(strict_types=1);

namespace App\Domain\Setup;

use App\Models\Setting;

/** Đọc giá trị cài đặt hệ thống (bảng settings, mặc định theo config/itso_settings.php). Không đọc khóa secret. */
final class Settings
{
    public static function get(string $group, string $key): mixed
    {
        $def = (array) config("itso_settings.$group.$key", []);
        if (($def['secret'] ?? false) === true) {
            return null;
        }
        $row = Setting::query()->where('group_key', $group)->where('key', $key)->first();

        return $row !== null && is_array($row->value) && array_key_exists('v', $row->value) ? $row->value['v'] : ($def['default'] ?? null);
    }
}
