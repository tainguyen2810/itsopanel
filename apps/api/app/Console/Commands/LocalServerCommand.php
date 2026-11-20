<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Servers\ServerFacts;
use Illuminate\Console\Command;

/** Tạo/cập nhật server local và làm mới dữ kiện từ agent (system.info). */
final class LocalServerCommand extends Command
{
    protected $signature = 'itso:server-local {--no-refresh : Chỉ tạo bản ghi, không gọi agent}';

    protected $description = 'Tạo bản ghi server local (Phase 3) và đọc dữ kiện từ agent';

    public function handle(ServerFacts $facts): int
    {
        $server = $facts->ensureLocal();
        $this->info("Server {$server->name} ({$server->uuid})");
        if ($this->option('no-refresh') === true) {
            return self::SUCCESS;
        }
        if (! $facts->refresh($server)) {
            $this->warn('Agent không trả lời; trạng thái: '.$server->status);

            return self::FAILURE;
        }
        $this->info("Đã cập nhật: {$server->os} / {$server->kernel}");

        return self::SUCCESS;
    }
}
