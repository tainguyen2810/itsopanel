<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Security\SafeApply;
use App\Domain\Security\SecurityAudit;
use App\Models\Server;
use Illuminate\Console\Command;

/**
 * Thu security.audit + tính điểm cho mọi máy chủ; đánh dấu safe-apply quá hạn là đã hoàn tác (sự kiện high).
 * Lịch: điểm mỗi 6 giờ, quét safe-apply quá hạn mỗi phút (`--expire-only`).
 */
final class SecurityAuditCommand extends Command
{
    protected $signature = 'itso:security-audit {--expire-only : Chỉ đánh dấu safe-apply quá hạn}';

    protected $description = 'Thu dữ kiện bảo mật và tính điểm';

    public function handle(SecurityAudit $audit, SafeApply $safe): int
    {
        $expired = $safe->expireStale();
        if ($expired > 0) {
            $this->warn("$expired lần áp dụng quá hạn đã được đánh dấu hoàn tác.");
        }
        if ($this->option('expire-only')) {
            return self::SUCCESS;
        }
        foreach (Server::query()->orderBy('id')->get() as $s) {
            $set = $audit->run($s);
            $this->info("{$s->name}: {$set->score}/100");
        }

        return self::SUCCESS;
    }
}
