<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Security\SecurityAudit;
use App\Models\Server;
use Illuminate\Console\Command;

/** So file hệ thống với baseline FIM của agent (ADR 0027). Lịch: mỗi giờ. */
final class FimCheckCommand extends Command
{
    protected $signature = 'itso:fim-check';

    protected $description = 'Kiểm toàn vẹn file hệ thống (FIM)';

    public function handle(SecurityAudit $audit): int
    {
        $n = 0;
        foreach (Server::query()->orderBy('id')->get() as $s) {
            $n += $audit->fimCheck($s);
        }
        $this->info("Phát hiện $n thay đổi mới.");

        return self::SUCCESS;
    }
}
