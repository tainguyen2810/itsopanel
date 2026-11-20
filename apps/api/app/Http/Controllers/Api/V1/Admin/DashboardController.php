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
 * Cảnh báo (Phase 11) và sự kiện bảo mật (Phase 7) chưa có nguồn dữ liệu → 0.
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
            'alerts_firing' => 0,
            'security_events_24h' => 0,
            'jobs_running' => $this->access->jobs($u)->whereIn('state', ['queued', 'running'])->count(),
            'updated_at' => Carbon::now()->toIso8601String(),
        ]]);
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
