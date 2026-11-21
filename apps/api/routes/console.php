<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Phase 4: thu số liệu qua agent. Chạy bởi itso-scheduler.timer (`php artisan schedule:run` mỗi phút).
Schedule::command('itso:metrics-collect')->everyMinute()->withoutOverlapping();
Schedule::command('itso:usage-refresh')->everyFiveMinutes()->withoutOverlapping();

// Phase 5: gia hạn chứng chỉ ACME (< 30 ngày) và đồng bộ DNS Cloudflare.
Schedule::command('itso:certs-renew')->dailyAt('03:17')->withoutOverlapping();
Schedule::command('itso:dns-sync')->hourlyAt(23)->withoutOverlapping();
