<?php

declare(strict_types=1);

namespace App\Domain\Hosting;

use App\Models\HostingPackageVersion;

/** Giới hạn gói (PackageLimits trong OpenAPI) ↔ cột hosting_package_versions. */
final class PackageLimits
{
    /** Khóa số nguyên (có thể override theo account qua limits_override). */
    public const INT_KEYS = ['disk_mb', 'inode_limit', 'cpu_percent', 'ram_mb', 'tasks_max', 'php_workers_max', 'io_weight',
        'website_limit', 'alias_domain_limit', 'subdomain_limit', 'database_limit', 'db_user_limit', 'ftp_limit',
        'cron_limit', 'cron_min_interval_min', 'backup_quota_mb', 'retention_days_after_terminate'];

    public const NULLABLE_KEYS = ['io_read_bps', 'io_write_bps'];

    /** @return array<string, list<mixed>> luật validate Laravel cho `limits` (đủ mọi khóa) */
    public static function rules(string $prefix = 'limits'): array
    {
        $min1 = ['disk_mb', 'inode_limit', 'cpu_percent', 'ram_mb', 'tasks_max', 'php_workers_max', 'cron_min_interval_min'];
        $r = [$prefix => ['required', 'array:'.implode(',', array_merge(self::INT_KEYS, self::NULLABLE_KEYS,
            ['backup_retention', 'ssh_allowed', 'php_versions']))]];
        foreach (self::INT_KEYS as $k) {
            $r["$prefix.$k"] = ['required', 'integer', 'max:2147483647',
                match (true) {
                    $k === 'io_weight' => 'between:1,10000',
                    $k === 'retention_days_after_terminate' => 'min:30',
                    in_array($k, $min1, true) => 'min:1',
                    default => 'min:0',
                }];
        }
        foreach (self::NULLABLE_KEYS as $k) {
            $r["$prefix.$k"] = ['present', 'nullable', 'integer', 'min:1'];
        }
        $r["$prefix.backup_retention"] = ['present', 'array'];
        $r["$prefix.backup_retention.*"] = ['integer', 'min:0'];
        $r["$prefix.ssh_allowed"] = ['required', 'boolean'];
        $r["$prefix.php_versions"] = ['present', 'array'];
        $r["$prefix.php_versions.*"] = ['string', 'regex:/^[5-9]\.[0-9]$/', 'distinct'];

        return $r;
    }

    /** @return array<string, mixed> */
    public static function of(HostingPackageVersion $v): array
    {
        $out = [];
        foreach (self::INT_KEYS as $k) {
            $out[$k] = (int) $v->getAttribute($k);
        }
        foreach (self::NULLABLE_KEYS as $k) {
            $val = $v->getAttribute($k);
            $out[$k] = $val === null ? null : (int) $val;
        }
        $out['backup_retention'] = (object) array_map('intval', $v->backup_retention);
        $out['ssh_allowed'] = $v->ssh_allowed;
        $out['php_versions'] = $v->php_versions;

        return $out;
    }

    /**
     * So sánh hai bộ giới hạn (bỏ qua thứ tự php_versions/backup_retention).
     *
     * @param  array<string, mixed>  $a
     * @param  array<string, mixed>  $b
     */
    public static function same(array $a, array $b): bool
    {
        return self::normalize($a) === self::normalize($b);
    }

    /**
     * @param  array<string, mixed>  $l
     * @return array<string, mixed>
     */
    private static function normalize(array $l): array
    {
        $l['backup_retention'] = (array) ($l['backup_retention'] ?? []);
        ksort($l['backup_retention']);
        $l['backup_retention'] = array_map('intval', $l['backup_retention']);
        $php = (array) ($l['php_versions'] ?? []);
        sort($php);
        $l['php_versions'] = $php;
        foreach (self::INT_KEYS as $k) {
            $l[$k] = (int) ($l[$k] ?? 0);
        }
        foreach (self::NULLABLE_KEYS as $k) {
            $l[$k] = isset($l[$k]) ? (int) $l[$k] : null;
        }
        $l['ssh_allowed'] = (bool) ($l['ssh_allowed'] ?? false);
        ksort($l);

        return $l;
    }

    /**
     * Cột DB từ limits đã validate.
     *
     * @param  array<string, mixed>  $l
     * @return array<string, mixed>
     */
    public static function columns(array $l): array
    {
        $cols = [];
        foreach (array_merge(self::INT_KEYS, self::NULLABLE_KEYS) as $k) {
            $cols[$k] = $l[$k];
        }
        $cols['backup_retention'] = (array) $l['backup_retention'];
        $cols['ssh_allowed'] = (bool) $l['ssh_allowed'];
        $cols['php_versions'] = array_values((array) $l['php_versions']);

        return $cols;
    }
}
