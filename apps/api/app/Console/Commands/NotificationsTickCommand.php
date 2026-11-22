<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Notifications\NotificationDispatcher;
use Illuminate\Console\Command;

/** Mỗi phút: gộp tin bị giới hạn tần suất thành tin tóm tắt; đưa lại vào queue lượt gửi đến hạn bị mất job (ADR 0048 §4–5). */
final class NotificationsTickCommand extends Command
{
    protected $signature = 'itso:notifications-tick';

    protected $description = 'Gửi tin tóm tắt cho kênh vượt giới hạn tần suất và thử lại lượt gửi đến hạn';

    public function handle(NotificationDispatcher $dispatcher): int
    {
        $s = $dispatcher->summarize();
        $r = $dispatcher->sweep();
        $this->info("$s tin tóm tắt, $r lượt gửi đưa lại vào queue.");

        return self::SUCCESS;
    }
}
