<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Security\WafService;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\Server;
use Illuminate\Console\Command;

/** Nạp sự kiện WAF từ audit log ModSecurity của agent (waf.events theo con trỏ). Lịch: mỗi phút. */
final class WafEventsSyncCommand extends Command
{
    protected $signature = 'itso:waf-events-sync';

    protected $description = 'Đồng bộ sự kiện WAF từ agent';

    public function handle(WafService $waf): int
    {
        $n = 0;
        foreach (Server::query()->orderBy('id')->get() as $s) {
            try {
                $n += $waf->sync($s);
            } catch (AgentUnavailable $e) {
                $this->warn("{$s->name}: agent không kết nối ({$e->getMessage()}).");
            }
        }
        $this->info("Đã ghi $n sự kiện WAF.");

        return self::SUCCESS;
    }
}
