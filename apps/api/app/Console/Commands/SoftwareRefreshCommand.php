<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Servers\SoftwareService;
use App\Models\Server;
use Illuminate\Console\Command;

/** Đồng bộ catalog phần mềm và bản cài/bản mới từ agent (D-100). Lịch: hằng ngày. */
final class SoftwareRefreshCommand extends Command
{
    protected $signature = 'itso:software-refresh {server? : uuid server (bỏ trống = mọi server)}';

    protected $description = 'Đồng bộ catalog phần mềm và phiên bản từ agent';

    public function handle(SoftwareService $software): int
    {
        $q = Server::query()->orderBy('id');
        if (is_string($u = $this->argument('server'))) {
            $q->where('uuid', $u);
        }
        foreach ($q->get() as $s) {
            $n = $software->refresh($s);
            $this->info("{$s->name}: catalog {$n['catalog']}, trạng thái {$n['status']}");
        }

        return self::SUCCESS;
    }
}
