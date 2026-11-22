<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Phase 4: thu số liệu qua agent. Chạy bởi itso-scheduler.timer (`php artisan schedule:run` mỗi phút).
Schedule::command('itso:metrics-collect')->everyMinute()->withoutOverlapping();
// Phase 9: trạng thái node qua itso-relay, job waiting_agent, danh sách thu hồi (D-91).
Schedule::command('itso:relay-sync')->everyMinute()->withoutOverlapping();
Schedule::command('itso:migrations-cleanup')->hourly()->withoutOverlapping();
Schedule::command('itso:usage-refresh')->everyFiveMinutes()->withoutOverlapping();

// Phase 5: gia hạn chứng chỉ ACME (< 30 ngày) và đồng bộ DNS Cloudflare.
Schedule::command('itso:certs-renew')->dailyAt('03:17')->withoutOverlapping();
Schedule::command('itso:dns-sync')->hourlyAt(23)->withoutOverlapping();

// Phase 6: ghi lần chạy cron theo lịch (cron.inspect).
Schedule::command('itso:cron-sync')->everyFiveMinutes()->withoutOverlapping();
Schedule::command('itso:terminal-reap')->everyFiveMinutes()->withoutOverlapping(); // 7.5: theo pty.list

// Phase 7: Security Center (D-76…D-81).
Schedule::command('itso:waf-events-sync')->everyMinute()->withoutOverlapping();
Schedule::command('itso:security-audit --expire-only')->everyMinute()->withoutOverlapping();
Schedule::command('itso:security-audit')->cron('7 */6 * * *')->withoutOverlapping();
Schedule::command('itso:fim-check')->hourlyAt(53)->withoutOverlapping();

// Phase 8: backup theo chính sách (khóa Redis + jitter) và kiểm chứng định kỳ (check tuần, restore test tháng).
Schedule::command('itso:backup-due')->everyFiveMinutes()->withoutOverlapping();
Schedule::command('itso:backup-verify')->dailyAt('04:41')->withoutOverlapping();
// 8.5: khôi phục thảm họa: xếp hàng khôi phục dữ liệu account sau khi panel được khôi phục (không làm gì khi chưa bật).
Schedule::command('itso:dr-restore')->everyFiveMinutes()->withoutOverlapping();

// Phase 10: catalog phần mềm + bản mới từ agent (D-100).
Schedule::command('itso:software-refresh')->dailyAt('05:23')->withoutOverlapping();

// Phase 10: WordPress Toolkit (D-99) — làm mới bản mới hằng ngày, tự cập nhật theo cửa sổ giờ (kiểm mỗi giờ).
Schedule::command('itso:wordpress-auto-update --refresh')->dailyAt('01:37')->withoutOverlapping();
Schedule::command('itso:wordpress-auto-update')->hourlyAt(5)->withoutOverlapping();

// Phase 11: lưu trữ số liệu (D-101) — rollup 1 giờ, tạo trước/drop partition và xóa rollup quá 90 ngày.
Schedule::command('itso:metrics-rollup')->hourlyAt(2)->withoutOverlapping();
Schedule::command('itso:metrics-prune')->dailyAt('00:13')->withoutOverlapping();
