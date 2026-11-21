<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Dns\DnsService;
use App\Exceptions\ApiProblem;
use App\Models\DnsZone;
use Illuminate\Console\Command;

/** Đồng bộ bản ghi mọi zone từ Cloudflare về DB (D-70; Cloudflare là nguồn sự thật). Lịch: mỗi giờ. */
final class DnsSyncCommand extends Command
{
    protected $signature = 'itso:dns-sync {zone? : Tên zone (mặc định: tất cả)}';

    protected $description = 'Đồng bộ bản ghi DNS từ Cloudflare';

    public function handle(DnsService $dns): int
    {
        $q = DnsZone::query()->with('provider')->orderBy('name');
        if (is_string($this->argument('zone'))) {
            $q->where('name', strtolower($this->argument('zone')));
        }
        $failed = 0;
        foreach ($q->get() as $z) {
            try {
                $z = $dns->sync(null, $z);
                $this->line($z->name.': '.$z->records()->count().' bản ghi');
            } catch (ApiProblem $e) {
                $failed++;
                $this->warn($z->name.': '.($e->detail ?? $e->getMessage()));
            }
        }

        return $failed === 0 ? self::SUCCESS : self::FAILURE;
    }
}
