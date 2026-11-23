<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Domain\System\ProductionReadiness;
use Illuminate\Http\JsonResponse;

/** GET /api/v1/admin/system/readiness (getSystemReadiness): chỉ SUPER_ADMIN (quyền settings.read), chỉ đọc. */
final class ReadinessController
{
    public function show(ProductionReadiness $readiness): JsonResponse
    {
        return response()->json(['data' => $readiness->report()]);
    }
}
