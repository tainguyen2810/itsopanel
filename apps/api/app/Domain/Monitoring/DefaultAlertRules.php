<?php

declare(strict_types=1);

namespace App\Domain\Monitoring;

use App\Models\AlertRule;
use Illuminate\Support\Facades\DB;

/**
 * Rule mặc định (D-102, ADR 0047 §5): tạo nếu thiếu (theo default_key), không ghi đè phần người dùng đã sửa.
 * Sửa được ngưỡng/thời gian/mức/kênh/bật tắt; không xóa, không đổi metric/phạm vi.
 */
final class DefaultAlertRules
{
    /** key → [tên, metric, phạm vi, toán tử, ngưỡng, duration_sec, mức, kênh] */
    public const RULES = [
        'agent_offline' => ['Server mất kết nối', 'agent_offline_sec', 'server', 'gte', 90, 0, 'critical', ['in_app', 'email']],
        'disk' => ['Disk server > 90%', 'disk_pct', 'server', 'gt', 90, 60, 'high', ['in_app', 'email']],
        'inode' => ['Inode server > 90%', 'inode_pct', 'server', 'gt', 90, 300, 'high', ['in_app', 'email']],
        'ram' => ['RAM server > 95% trong 10 phút', 'ram_pct', 'server', 'gt', 95, 600, 'high', ['in_app', 'email']],
        'service_down' => ['Dịch vụ lõi dừng', 'service_down', 'server', 'gte', 1, 120, 'high', ['in_app', 'email']],
        'uptime_down' => ['Website không phản hồi', 'uptime_down', 'website', 'gte', 1, 0, 'high', ['in_app', 'email']],
        'cert_expiring' => ['Chứng chỉ còn ≤ 7 ngày', 'cert_days', 'website', 'lte', 7, 0, 'medium', ['in_app', 'email']],
        'backup_failed' => ['Backup lỗi', 'backup_failed', 'hosting_account', 'gte', 1, 0, 'high', ['in_app', 'email']],
        'quota_full' => ['Quota disk account ≥ 100%', 'quota_disk_pct', 'hosting_account', 'gte', 100, 0, 'high', ['in_app', 'email']],
    ];

    public function ensure(): int
    {
        $have = DB::table('alert_rules')->whereNotNull('default_key')->pluck('default_key')->all();
        $n = 0;
        foreach (self::RULES as $key => [$name, $metric, $scope, $op, $thr, $for, $sev, $ch]) {
            if (in_array($key, $have, true)) {
                continue;
            }
            $r = new AlertRule(['name' => $name, 'metric' => $metric, 'scope_type' => $scope, 'operator' => $op,
                'threshold' => $thr, 'duration_sec' => $for, 'severity' => $sev, 'repeat_sec' => 14400, 'is_default' => true,
                'default_key' => $key, 'enabled' => true]);
            $r->channels = $ch;
            $r->channel_ids = [];
            $r->save();
            $n++;
        }

        return $n;
    }
}
