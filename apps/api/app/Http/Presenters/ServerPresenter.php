<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Models\Agent;
use App\Models\HostingAccount;
use App\Models\Server;
use Illuminate\Support\Carbon;

/** Server theo contracts/openapi/itso-admin-v1.yaml (components.schemas.Server). */
final class ServerPresenter
{
    /** @return array<string, mixed> */
    public function server(Server $s): array
    {
        $agent = Agent::query()->where('server_id', $s->id)->first();
        $f = $s->observed_facts;
        $int = fn (string $k): int => is_numeric($f[$k] ?? null) ? (int) $f[$k] : 0;
        $num = fn (string $k): float => is_numeric($f[$k] ?? null) ? (float) $f[$k] : 0.0;

        return [
            'uuid' => $s->uuid,
            'name' => $s->name,
            'hostname' => $s->hostname,
            'ip_addresses' => array_values(array_map('strval', $s->ip_addresses)),
            'role_tags' => $s->role_tags,
            'os' => $s->os,
            'kernel' => $s->kernel,
            'agent_version' => $agent?->version,
            'agent_connected' => self::connected($agent),
            'accepting_new_accounts' => $s->accepting_new_accounts,
            'resources' => [
                'cpu_cores' => $int('cpu_cores'), 'ram_mb' => $int('ram_mb'), 'disk_mb' => $int('disk_mb'),
                'cpu_pct' => $num('cpu_pct'), 'ram_used_mb' => $int('ram_used_mb'), 'disk_used_mb' => $int('disk_used_mb'),
                'load_1m' => $num('load_1m'), 'uptime_sec' => $int('uptime_sec'),
            ],
            'account_count' => HostingAccount::query()->where('server_id', $s->id)->count(),
            'status' => $s->status,
            'spec_version' => max(1, $s->spec_version),
            'observed_version' => max(0, $s->observed_version),
            'drift' => $s->drift === null || $s->drift === [] ? null : array_map('strval', $s->drift),
            'observed_at' => $s->observed_at?->toIso8601String(),
            'created_at' => $s->created_at->toIso8601String(),
            'updated_at' => $s->updated_at->toIso8601String(),
        ];
    }

    public static function connected(?Agent $agent): bool
    {
        $window = (int) config('itso.agent.connected_window_sec', 300);

        return $agent?->last_seen_at instanceof Carbon && $agent->last_seen_at->gte(Carbon::now()->subSeconds($window));
    }

    public static function etag(Server $s): string
    {
        return '"srv-'.$s->spec_version.'-'.$s->updated_at->format('U.u').'"';
    }
}
