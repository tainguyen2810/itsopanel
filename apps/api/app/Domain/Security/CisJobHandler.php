<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Jobs\JobHandler;
use App\Models\Job;
use App\Models\Server;

/** cis.audit xong → lưu cis_results rồi tính lại điểm bảo mật (mục CIS L1). */
final class CisJobHandler implements JobHandler
{
    public function __construct(private readonly CisService $cis, private readonly SecurityAudit $audit) {}

    public function succeeded(Job $job): void
    {
        if ($this->cis->store($job) !== null && ($s = Server::query()->find($job->server_id)) instanceof Server) {
            $this->audit->rescore($s);
        }
    }

    public function failed(Job $job): void {}
}
