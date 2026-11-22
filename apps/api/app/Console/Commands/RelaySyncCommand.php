<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Servers\RelaySync;
use Illuminate\Console\Command;

final class RelaySyncCommand extends Command
{
    protected $signature = 'itso:relay-sync';

    protected $description = 'Đồng bộ trạng thái node với itso-relay, chạy tiếp job chờ node, đẩy danh sách thu hồi (Phase 9)';

    public function handle(RelaySync $sync): int
    {
        $r = $sync->sync();
        $this->info(sprintf('%d node, %d online, %d đổi trạng thái, %d job chạy tiếp%s', $r['nodes'], $r['online'], $r['changed'],
            $r['resumed'], $r['nodes'] > 0 && ! $r['relay'] ? ' (itso-relay không trả lời)' : ''));

        return self::SUCCESS;
    }
}
