<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Audit\AuditChain;
use Illuminate\Console\Command;

final class AuditVerifyCommand extends Command
{
    protected $signature = 'itso:audit-verify';

    protected $description = 'Kiểm chuỗi hash của nhật ký kiểm toán';

    public function handle(): int
    {
        $r = AuditChain::verify();
        if ($r['broken_id'] !== null) {
            $this->error("Chuỗi hash gãy tại bản ghi id={$r['broken_id']} (đã duyệt {$r['rows']} bản ghi).");

            return self::FAILURE;
        }
        $this->info("Chuỗi hash hợp lệ: {$r['rows']} bản ghi.");

        return self::SUCCESS;
    }
}
