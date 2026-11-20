<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Domain\Hosting\ProvisioningService;
use App\Exceptions\ApiProblem;
use App\Models\HostingAccount;
use Illuminate\Console\Command;

/** Áp lại desired state của các hosting account xuống agent (job hosting_account.reconcile). */
final class ReconcileCommand extends Command
{
    protected $signature = 'itso:reconcile {--account= : Chỉ một username}';

    protected $description = 'Đồng bộ lại account xuống agent (sau khi agent mock khởi động lại)';

    public function handle(ProvisioningService $provisioning): int
    {
        $q = HostingAccount::query()->whereIn('lifecycle_state', ['active', 'suspended', 'terminated'])->orderBy('id');
        $only = $this->option('account');
        if (is_string($only) && $only !== '') {
            $q->where('username', $only);
        }
        $n = 0;
        foreach ($q->get() as $a) {
            try {
                $job = $provisioning->reconcile($a);
                $this->line("{$a->username}: job {$job->uuid}");
                $n++;
            } catch (ApiProblem $e) {
                $this->warn("{$a->username}: {$e->detail}");
            }
        }
        $this->info("Đã xếp hàng $n job đồng bộ.");

        return self::SUCCESS;
    }
}
