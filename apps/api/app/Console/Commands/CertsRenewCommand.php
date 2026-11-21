<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Web\CertificateService;
use App\Exceptions\ApiProblem;
use Illuminate\Console\Command;

/**
 * Gia hạn chứng chỉ ACME còn dưới 30 ngày (D-69): mỗi chứng chỉ một job certificate.renew (cert.issue renew).
 * Thất bại → CertificateJobHandler ghi last_error, audit, báo SUPER_ADMIN. Lịch: hằng ngày (routes/console.php).
 */
final class CertsRenewCommand extends Command
{
    protected $signature = 'itso:certs-renew {--dry-run : Chỉ liệt kê chứng chỉ sẽ gia hạn}';

    protected $description = 'Gia hạn chứng chỉ ACME sắp hết hạn';

    public function handle(CertificateService $certs): int
    {
        $due = $certs->due();
        $ok = 0;
        foreach ($due as $c) {
            $line = $c->uuid.' '.implode(',', $c->domains).' hết hạn '.($c->not_after?->toDateString() ?? '?');
            if ($this->option('dry-run')) {
                $this->line($line);

                continue;
            }
            try {
                $job = $certs->renew(null, $c);
                $this->line("$line → job {$job->uuid}");
                $ok++;
            } catch (ApiProblem $e) {
                $this->warn("$line: bỏ qua ({$e->getMessage()})");
            }
        }
        $this->info(count($due).' chứng chỉ đến hạn'.($this->option('dry-run') ? '' : ", đã tạo $ok job gia hạn").'.');

        return self::SUCCESS;
    }
}
