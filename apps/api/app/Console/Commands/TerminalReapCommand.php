<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Terminal\TerminalService;
use Illuminate\Console\Command;

/** Đóng bản ghi phiên terminal agent không còn giữ (pty.list, Prompt 7.5); agent không trả lời → luật 12 giờ. Lịch: 5 phút. */
final class TerminalReapCommand extends Command
{
    protected $signature = 'itso:terminal-reap';

    protected $description = 'Dọn bản ghi phiên terminal quá hạn';

    public function handle(TerminalService $terminal): int
    {
        $this->info('Đã đóng '.$terminal->reap().' phiên terminal quá hạn.');

        return self::SUCCESS;
    }
}
