<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Backup\DisasterRecovery;
use Illuminate\Console\Command;

/**
 * Khôi phục thảm họa bước 3 (D-87): sau khi "itso panel-restore-apply" thay DB panel, khôi phục dữ liệu từng account
 * (website + database, ghi đè từ snapshot mới nhất) song song có giới hạn. --start bật luồng (gọi bởi panel-restore-apply);
 * lịch mỗi 5 phút xếp hàng tiếp tới khi mọi account xong.
 */
final class DrRestoreCommand extends Command
{
    protected $signature = 'itso:dr-restore {--start : Bật khôi phục dữ liệu account} {--parallel=2 : Số account khôi phục cùng lúc (1–8)} {--dry-run : Chỉ liệt kê}';

    protected $description = 'Khôi phục dữ liệu account sau khi khôi phục panel từ backup (DR)';

    public function handle(DisasterRecovery $dr): int
    {
        if ($this->option('start') && ! $this->option('dry-run')) {
            $dr->begin();
        }
        $parallel = min(8, max(1, (int) $this->option('parallel')));
        foreach ($dr->tick($parallel, (bool) $this->option('dry-run')) as $line) {
            $this->line($line);
        }

        return self::SUCCESS;
    }
}
