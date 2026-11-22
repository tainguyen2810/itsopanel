<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Servers\CertRotation;
use Illuminate\Console\Command;

/** Chạy bởi itso-cert-rotate.timer mỗi ngày (ADR 0036 §3). */
final class CertsRotateCommand extends Command
{
    protected $signature = 'itso:certs-rotate {--force : Xoay cả chứng chỉ chưa tới 2/3 hạn}';

    protected $description = 'Xoay chứng chỉ mTLS của node đã qua 2/3 hạn';

    public function handle(CertRotation $rotation): int
    {
        $r = $rotation->run($this->option('force') === true);
        $this->info("Đã xoay {$r['rotated']}, bỏ qua {$r['skipped']}.");
        foreach ($r['failed'] as $f) {
            $this->error($f);
        }

        return $r['failed'] === [] ? self::SUCCESS : self::FAILURE;
    }
}
