<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Security;

use App\Auth\Realm;
use App\Domain\Security\CisService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** /admin/security/cis (D-109, ADR 0054): kết quả kiểm CIS L1 theo server trong phạm vi; chạy kiểm = job chỉ đọc. */
final class CisController extends SecurityBase
{
    public function show(Request $request, CisService $cis): JsonResponse
    {
        return response()->json(['data' => $cis->report($this->serverQuery($request))]);
    }

    public function audit(Request $request, CisService $cis): JsonResponse
    {
        $job = $cis->audit($this->actor($request), $this->serverQuery($request));
        $data = $this->jobs->job($job->refresh(), Realm::ADMIN);

        return response()->json(['job' => $data, 'resource' => $data['resource']], 202);
    }
}
