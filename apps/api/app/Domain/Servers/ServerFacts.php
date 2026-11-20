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
            $server->save();
            Agent::query()->firstOrCreate(['server_id' => $server->id], ['transport' => 'local']);

            return $server->refresh();
        });
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
            $ping = $this->agent->call('system.ping');
            $info = $this->agent->call('system.info');
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
                'uptime_sec' => (int) ($d['uptime_sec'] ?? 0),
                'agent_hostname' => (string) ($d['hostname'] ?? ''),
                'agent_mode' => (string) ($ping->data['mode'] ?? ''),
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
