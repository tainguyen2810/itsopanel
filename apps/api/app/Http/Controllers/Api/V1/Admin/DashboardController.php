<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Admin;

use App\Auth\Access;
use App\Models\HostingPackage;
use App\Models\Server;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * /admin/dashboard/summary (Prompt 3.4): số liệu trong phạm vi người xem.
 * Từ 11.6: `alerts_firing` = cảnh báo firing của server/account trong phạm vi; `security_events_24h` = sự kiện bảo mật
 * 24 giờ qua của server trong phạm vi (SUPER_ADMIN: tất cả). Giao diện poll 30 giây (D-106).
 */
final class DashboardController
{
    public function __construct(private readonly Access $access) {}

    public function summary(Request $request): JsonResponse
    {
        /** @var User $u */
        $u = $request->user();
        $servers = $this->access->servers($u)->orderBy('name')->get();
        $accounts = $this->access->accounts($u);
        $byVersion = (clone $accounts)->select('package_version_id', DB::raw('count(*) as n'))
            ->groupBy('package_version_id')->pluck('n', 'package_version_id');
        $versionToPackage = DB::table('hosting_package_versions')->whereIn('id', $byVersion->keys())->pluck('package_id', 'id');
        $perPackage = [];
        foreach ($byVersion as $versionId => $n) {
            $pid = (int) ($versionToPackage[$versionId] ?? 0);
            $perPackage[$pid] = ($perPackage[$pid] ?? 0) + (int) $n;
        }
        $packages = HostingPackage::query()->orderBy('code')->get(['id', 'code']);

        return response()->json(['data' => [
            'counts' => [
                'servers' => $servers->count(),
                'hosting_accounts' => (clone $accounts)->count(),
                'users' => $this->access->users($u)->count(),
                'packages' => $packages->count(),
            ],
            'servers' => $servers->map(fn (Server $s): array => self::serverRow($s))->values()->all(),
            'package_distribution' => $packages->map(fn (HostingPackage $p): array => [
                'code' => $p->code, 'accounts' => $perPackage[$p->id] ?? 0,
            ])->values()->all(),
            'alerts_firing' => $this->alertsFiring($u),
            'security_events_24h' => DB::table('security_events')->where('at', '>=', Carbon::now()->subDay())
                ->when(! $this->access->isSuperAdmin($u), fn ($q) => $q->whereIn('server_id', $this->access->servers($u)->select('servers.id')))
                ->count(),
            'jobs_running' => $this->access->jobs($u)->whereIn('state', ['queued', 'running'])->count(),
            'updated_at' => Carbon::now()->toIso8601String(),
        ]]);
    }

    private function alertsFiring(User $u): int
    {
        $q = DB::table('alerts')->where('state', 'firing');
        if (! $this->access->isSuperAdmin($u)) {
            $servers = $this->access->servers($u)->select('servers.id');
            $accounts = $this->access->accounts($u)->select('hosting_accounts.id');
            $q->where(fn ($w) => $w->whereIn('server_id', $servers)->orWhereIn('hosting_account_id', $accounts));
        }

        return $q->count();
    }

    /** @return array{server: array{uuid: string, name: string}, status: string, cpu_pct: float, ram_pct: float, disk_pct: float} */
    private static function serverRow(Server $s): array
    {
        $f = $s->observed_facts;
        $pct = function (string $used, string $total) use ($f): float {
            $t = is_numeric($f[$total] ?? null) ? (float) $f[$total] : 0.0;

            return $t > 0 ? round((is_numeric($f[$used] ?? null) ? (float) $f[$used] : 0.0) * 100 / $t, 1) : 0.0;
        };

        return [
            'server' => ['uuid' => $s->uuid, 'name' => $s->name],
            'status' => $s->status,
            'cpu_pct' => is_numeric($f['cpu_pct'] ?? null) ? (float) $f['cpu_pct'] : 0.0,
            'ram_pct' => $pct('ram_used_mb', 'ram_mb'),
            'disk_pct' => $pct('disk_used_mb', 'disk_mb'),
        ];
    }
}
