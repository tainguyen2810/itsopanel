<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Portal;

use App\Auth\Access;
use App\Domain\Audit\AuditLogger;
use App\Http\Controllers\Api\V1\Admin\MonitoringController;
use App\Http\Presenters\MonitoringPresenter;
use App\Http\Support\Listing;
use App\Models\HostingAccount;
use App\Models\UptimeCheck;
use App\Models\User;
use App\Models\Website;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Portal: uptime website của tôi (D-105). USER chỉ thấy/sửa check của website thuộc account mình (ngoài phạm vi → 404);
 * chỉ đổi path, từ khóa, chu kỳ, bật/tắt — URL luôn là domain của website.
 */
final class PortalMonitoringController
{
    public function __construct(
        private readonly Access $access,
        private readonly MonitoringPresenter $present,
        private readonly AuditLogger $audit,
    ) {}

    public function accountUptime(Request $request, string $id): JsonResponse
    {
        $a = Str::isUuid($id) ? $this->access->accounts($this->user($request))->where('hosting_accounts.uuid', $id)
            ->where('lifecycle_state', '<>', 'purged')->first() : null;
        if (! $a instanceof HostingAccount) {
            throw new NotFoundHttpException;
        }
        $q = UptimeCheck::query()->with('website')->whereIn('website_id', Website::query()->where('hosting_account_id', $a->id)
            ->whereNotIn('status', ['deleting'])->select('id'));

        return response()->json(Listing::page($request, $q, ['created_at' => 'uptime_checks.created_at', 'state' => 'uptime_checks.state',
            'id' => 'uptime_checks.id'], '-created_at', fn (UptimeCheck $c): array => $this->present->uptime($c)));
    }

    public function website(Request $request, string $id): JsonResponse
    {
        $c = $this->check($request, $id);

        return response()->json(['data' => $this->present->uptime($c)])->header('ETag', MonitoringPresenter::uptimeEtag($c));
    }

    public function update(Request $request, string $id): JsonResponse
    {
        return MonitoringController::applyUptime($request, $this->check($request, $id), $this->present, $this->audit);
    }

    public function results(Request $request, string $id): JsonResponse
    {
        return MonitoringController::results($request, $this->check($request, $id));
    }

    private function check(Request $request, string $id): UptimeCheck
    {
        $w = Str::isUuid($id) ? Website::query()->where('uuid', $id)->whereNotIn('status', ['deleting'])
            ->whereIn('hosting_account_id', $this->access->accounts($this->user($request))->select('hosting_accounts.id'))->first() : null;
        $c = $w instanceof Website ? UptimeCheck::query()->with('website')->where('website_id', $w->id)->first() : null;
        if (! $c instanceof UptimeCheck) {
            throw new NotFoundHttpException;
        }

        return $c;
    }

    private function user(Request $request): User
    {
        /** @var User */
        return $request->user();
    }
}
