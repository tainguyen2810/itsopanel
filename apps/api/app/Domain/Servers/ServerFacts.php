<?php

declare(strict_types=1);

namespace App\Domain\Servers;

use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\Agent;
use App\Models\Server;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Server local và dữ kiện quan sát (observed) lấy từ agent qua op `system.info` + `system.ping`.
 * Không chạy lệnh hệ thống: chỉ gọi typed operation.
 */
final class ServerFacts
{
    public function __construct(private readonly AgentClient $agent) {}

    /** Tạo/cập nhật bản ghi server local theo config('itso.local_server') (desired). */
    public function ensureLocal(): Server
    {
        /** @var array{name: string, hostname: string, role_tags: list<string>} $cfg */
        $cfg = config('itso.local_server');

        return DB::transaction(function () use ($cfg): Server {
            $server = Server::query()->withTrashed()->where('name', $cfg['name'])->first()
                ?? new Server(['name' => $cfg['name'], 'role_tags' => $cfg['role_tags'], 'status' => 'pending']);
            $server->hostname = $server->exists ? $server->hostname : $cfg['hostname'];
            $server->deleted_at = null;
            // Phase 9 (D-88): vai trò cài đặt trong /etc/itso/node.json; control plane mặc định không nhận account.
            $role = self::installRole();
            if ($role !== null && $server->node_role !== $role) {
                if (! $server->exists && $role === 'control_plane') {
                    $server->accepting_new_accounts = false;
                }
                $server->node_role = $role;
            }
            $server->save();
            Agent::query()->firstOrCreate(['server_id' => $server->id], ['transport' => 'local']);

            return $server->refresh();
        });
    }

    /** all_in_one|control_plane theo /etc/itso/node.json; null nếu chưa có (cài từ Phase 4–8). */
    public static function installRole(): ?string
    {
        $f = config('itso.node_identity_file');
        $raw = is_string($f) && $f !== '' ? @file_get_contents($f) : false;
        $j = is_string($raw) ? json_decode($raw, true) : null;

        return match (is_array($j) ? ($j['role'] ?? null) : null) {
            'control-plane' => 'control_plane',
            'all-in-one' => 'all_in_one',
            default => null,
        };
    }

    /**
     * Hỏi agent rồi ghi observed_facts/os/kernel/status. Agent không trả lời → status degraded, giữ dữ kiện cũ.
     *
     * @return bool agent có trả lời không
     */
    public function refresh(Server $server): bool
    {
        $now = Carbon::now();
        try {
            $agent = $this->agent->forServer($server->id);
            $ping = $agent->call('system.ping');
            $info = $agent->call('system.info');
        } catch (AgentUnavailable) {
            $server->forceFill(['status' => $server->status === 'pending' ? 'pending' : 'degraded'])->save();

            return false;
        }
        if (! $ping->ok || ! $info->ok || $info->data === null) {
            $server->forceFill(['status' => 'degraded'])->save();

            return false;
        }
        $d = $info->data;
        $server->forceFill([
            'os' => is_string($d['os'] ?? null) ? $d['os'] : $server->os,
            'kernel' => is_string($d['kernel'] ?? null) ? $d['kernel'] : $server->kernel,
            'observed_facts' => array_merge($server->observed_facts, [
                'cpu_cores' => (int) ($d['cpu_cores'] ?? 0),
                'ram_mb' => (int) ($d['ram_mb'] ?? 0),
                'disk_mb' => (int) ($d['disk_total_mb'] ?? 0),
                'disk_used_mb' => max(0, (int) ($d['disk_total_mb'] ?? 0) - (int) ($d['disk_free_mb'] ?? 0)),
                'uptime_sec' => (int) ($d['uptime_sec'] ?? 0),
                'agent_hostname' => (string) ($d['hostname'] ?? ''),
                'agent_mode' => (string) ($ping->data['mode'] ?? ''),
                'platform' => [
                    'quota_mode' => in_array($d['quota_mode'] ?? null, ['kernel', 'soft'], true) ? $d['quota_mode'] : 'unknown',
                    'cgroup_v2' => (bool) ($d['cgroup_v2'] ?? false),
                    'systemd' => (bool) ($d['systemd'] ?? false),
                    'arch' => (string) ($d['arch'] ?? ''),
                    'facts_at' => $now->toIso8601String(),
                ],
            ]),
            'observed_at' => $now,
            'observed_version' => $server->spec_version,
            'status' => 'ready',
        ])->save();
        Agent::query()->updateOrCreate(['server_id' => $server->id],
            ['version' => $ping->agentVersion !== '' ? $ping->agentVersion : null, 'last_seen_at' => $now]);

        return true;
    }
}
