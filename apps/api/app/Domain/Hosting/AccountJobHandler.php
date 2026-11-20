<?php

declare(strict_types=1);

namespace App\Domain\Hosting;

use App\Domain\Jobs\JobHandler;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\User;
use Illuminate\Support\Carbon;

/**
 * Cập nhật observed state của account khi job agent kết thúc (đăng ký cho mọi job hosting_account.* và
 * package.migrate_accounts trong config itso.job_handlers). Chỉ đụng account có last_job_id = job này.
 */
final class AccountJobHandler implements JobHandler
{
    public function __construct(private readonly ProvisioningService $provisioning) {}

    public function succeeded(Job $job): void
    {
        $actor = $job->requested_by_user_id !== null ? User::query()->find($job->requested_by_user_id) : null;
        foreach ($this->accounts($job) as $a) {
            if ($job->type === 'hosting_account.create' && $a->lifecycle_state !== 'active') {
                $this->provisioning->event($a, $a->lifecycle_state, 'active', null, $actor, $job);
                $a->lifecycle_state = 'active';
            }
            $a->status = AccountLifecycle::STATUS[$a->lifecycle_state] ?? 'ready';
            $a->observed_version = $a->spec_version;
            $a->observed_at = Carbon::now();
            $a->drift = null;
            $a->save();
        }
    }

    public function failed(Job $job): void
    {
        foreach ($this->accounts($job) as $a) {
            if ($job->type === 'hosting_account.create') {
                if ($a->lifecycle_state !== 'failed') {
                    $this->provisioning->event($a, $a->lifecycle_state, 'failed', $job->error_code, null, $job);
                }
                $a->lifecycle_state = 'failed';
                $a->status = 'failed';
            } else {
                $a->status = 'degraded';
                $a->drift = ['apply' => mb_substr((string) ($job->error_message ?? $job->state), 0, 200)];
            }
            $a->observed_at = Carbon::now();
            $a->save();
        }
    }

    /** @return iterable<HostingAccount> */
    private function accounts(Job $job): iterable
    {
        return HostingAccount::query()->where('last_job_id', $job->id)->lockForUpdate()->get();
    }
}
