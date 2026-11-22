<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Notifications\UserEvents;
use App\Models\Certificate;
use Illuminate\Console\Command;
use Illuminate\Support\Carbon;

/** Hằng ngày: báo chứng chỉ sắp hết hạn ở mốc 14/7/1 ngày cho admin trong phạm vi và USER chủ website (ADR 0049 §4). */
final class CertificatesExpiryCommand extends Command
{
    protected $signature = 'itso:certificates-expiry';

    protected $description = 'Thông báo chứng chỉ sắp hết hạn (14/7/1 ngày)';

    public function handle(UserEvents $events): int
    {
        $now = Carbon::now();
        $n = 0;
        Certificate::query()->whereIn('status', ['ready', 'degraded'])->whereNotNull('not_after')
            ->where('not_after', '>', $now)->where('not_after', '<=', $now->copy()->addDays(UserEvents::CERT_DAYS[0]))
            ->orderBy('id')->each(function (Certificate $c) use ($events, $now, &$n): void {
                $n += $events->certificateExpiring($c, $now) ? 1 : 0;
            });
        $this->info("$n thông báo chứng chỉ sắp hết hạn.");

        return self::SUCCESS;
    }
}
