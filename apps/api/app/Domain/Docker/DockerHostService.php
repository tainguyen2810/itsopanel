<?php

declare(strict_types=1);

namespace App\Domain\Docker;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\ComposeProject;
use App\Models\DockerContainer;
use App\Models\DockerHost;
use App\Models\FirewallRule;
use App\Models\Job;
use App\Models\PortAllocation;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Carbon;

/**
 * Docker trên server (D-94, D-95): bật bằng recipe `docker` + daemon.json an toàn + DOCKER-USER; trạng thái đọc qua
 * docker.host.status (làm mới tối đa mỗi phút); rule firewall scope=docker → docker.firewall.sync.
 */
final class DockerHostService
{
    public const DAEMON_DEFAULTS = ['default_bind_ip' => '127.0.0.1', 'userland_proxy' => false, 'live_restore' => true,
        'log_max_size' => '10m', 'log_max_file' => 3];

    public function __construct(private readonly JobDispatcher $jobs, private readonly AuditLogger $audit,
        private readonly AgentClient $agent) {}

    public function host(Server $s): DockerHost
    {
        return DockerHost::query()->find($s->id) ?? new DockerHost(['server_id' => $s->id, 'enabled' => false,
            'state' => 'not_installed', 'daemon_config' => [], 'checks' => [], 'port_range_from' => 20000, 'port_range_to' => 29999]);
    }

    /** Docker phải đã bật trên server trước khi tạo/chạy compose hoặc thao tác container. */
    public function requireEnabled(Server $s): DockerHost
    {
        $h = $this->host($s);
        if (! $h->exists || ! $h->enabled) {
            throw new ApiProblem(409, 'precondition_failed', 'Docker chưa bật', 'Bật Docker trên máy chủ này trước (docker:enable).');
        }

        return $h;
    }

    /** Làm mới trạng thái từ agent (đọc, đồng bộ); agent không trả lời thì giữ bản cũ. */
    public function refresh(Server $s, bool $force = false): DockerHost
    {
        $h = $this->host($s);
        if (! $h->exists || ! $h->enabled || (! $force && $h->observed_at !== null && $h->observed_at->gt(Carbon::now()->subMinute()))) {
            return $h;
        }
        try {
            $r = $this->agent->forServer($s->id)->call('docker.host.status', [], null, null, 30.0);
        } catch (AgentUnavailable) {
            return $h;
        }
        if (! $r->ok || $r->data === null) {
            return $h;
        }
        $d = $r->data;
        $checks = array_values(array_filter((array) ($d['checks'] ?? []), 'is_array'));
        $allOk = ($d['installed'] ?? false) === true && ! collect($checks)->contains(fn (array $c): bool => ($c['ok'] ?? false) !== true);
        $cfg = $h->daemon_config;
        $cfg['observed_counts'] = (array) ($d['counts'] ?? []);
        $cfg['docker_group_members'] = array_values(array_map('strval', (array) ($d['docker_group_members'] ?? [])));
        $h->fill(['engine_version' => $d['engine_version'] ?? null, 'compose_version' => $d['compose_version'] ?? null,
            'api_version' => $d['api_version'] ?? null, 'checks' => $checks, 'daemon_config' => $cfg,
            'state' => $allOk ? 'enabled' : 'degraded', 'observed_at' => Carbon::now()])->save();

        return $h;
    }

    /** @return array<string, mixed> DockerHost */
    public function present(Server $s): array
    {
        $h = $this->refresh($s);
        $cfg = $h->daemon_config;
        $counts = (array) ($cfg['observed_counts'] ?? []);
        $cached = DockerContainer::query()->where('server_id', $s->id);

        return [
            'server' => ['uuid' => $s->uuid, 'name' => $s->name], 'state' => $h->state,
            'engine_version' => $h->engine_version, 'compose_version' => $h->compose_version, 'api_version' => $h->api_version,
            'daemon' => array_merge(self::DAEMON_DEFAULTS, array_intersect_key((array) ($cfg['daemon'] ?? []), self::DAEMON_DEFAULTS)),
            'checks' => array_map(fn (array $c): array => ['key' => (string) $c['key'], 'ok' => (bool) ($c['ok'] ?? false),
                'detail' => (string) ($c['detail'] ?? '')], array_values(array_filter($h->checks, fn (array $c): bool => isset($c['key'])))),
            'docker_group_members' => array_values(array_map('strval', (array) ($cfg['docker_group_members'] ?? []))),
            'firewall' => ['synced_at' => $h->firewall_synced_at?->toIso8601String(), 'open_ports' => array_map(
                fn (array $p): array => $p + ['note' => ''], $this->openPorts($s, true))],
            'port_range' => ['from' => $h->port_range_from, 'to' => $h->port_range_to],
            'ports_allocated' => PortAllocation::query()->where('server_id', $s->id)->count(),
            'counts' => [
                'containers' => (int) ($counts['containers'] ?? (clone $cached)->count()),
                'running' => (int) ($counts['running'] ?? (clone $cached)->where('state', 'running')->count()),
                'images' => (int) ($counts['images'] ?? 0), 'volumes' => (int) ($counts['volumes'] ?? 0),
                'projects' => ComposeProject::query()->where('server_id', $s->id)->count(),
            ],
            'observed_at' => $h->observed_at?->toIso8601String(),
        ];
    }

    /**
     * Cổng mở từ Internet vào container: rule firewall scope=docker đang bật (accept/in/tcp|udp, cổng cụ thể).
     *
     * @return list<array{port: int, protocol: string, source: string, note?: string}>
     */
    public function openPorts(Server $s, bool $withNote = false): array
    {
        $out = [];
        $rules = FirewallRule::query()->where('server_id', $s->id)->where('scope', 'docker')->where('enabled', true)
            ->orderBy('priority')->orderBy('id')->get();
        foreach ($rules as $r) {
            foreach (explode(',', (string) $r->port_range) as $port) {
                if (! ctype_digit($port) || (int) $port < 1 || (int) $port > 65535 || count($out) >= 200) {
                    continue;
                }
                $row = ['port' => (int) $port, 'protocol' => $r->protocol, 'source' => (string) ($r->source_cidr ?? '0.0.0.0/0')];
                if ($withNote) {
                    $row['note'] = (string) ($r->comment ?? '');
                }
                $out[] = $row;
            }
        }

        return $out;
    }

    /** @return array{public_interface: string, open_ports: list<array{port: int, protocol: string, source: string}>} */
    public function firewallParams(Server $s): array
    {
        $iface = (string) ($this->host($s)->daemon_config['public_interface'] ?? config('itso.docker.public_interface', 'eth0'));
        if (preg_match('/^[a-z0-9][a-z0-9_.-]{0,14}$/', $iface) !== 1) {
            $iface = 'eth0';
        }

        return ['public_interface' => $iface, 'open_ports' => $this->openPorts($s)];
    }

    public function enable(User $actor, Server $s): Job
    {
        $this->ensureNoActiveJob($s, ['docker.enable']);
        $h = $this->host($s);
        if (! $h->enabled) {
            $h->state = 'installing';
        }
        $h->save();
        $spec = (new JobSpec('docker.enable', $s, $s->id, maxAttempts: 1, timeoutSec: 1800))
            ->step('software.install', ['recipe' => 'docker'])
            ->step('docker.host.configure', ['log_max_size_mb' => 10, 'log_max_file' => 3])
            ->step('docker.firewall.sync', $this->firewallParams($s));
        $job = $this->jobs->dispatch($spec, $actor);
        $this->audit->record('docker.enable', $s, ['public_interface' => $this->firewallParams($s)['public_interface']],
            'success', $s->id, $job->id, $actor);

        return $job;
    }

    public function syncFirewall(User $actor, Server $s): Job
    {
        $this->requireEnabled($s);
        $this->ensureNoActiveJob($s, ['docker.firewall_sync', 'docker.enable']);
        $params = $this->firewallParams($s);
        $job = $this->jobs->dispatch((new JobSpec('docker.firewall_sync', $s, $s->id, maxAttempts: 2, timeoutSec: 120))
            ->step('docker.firewall.sync', $params), $actor);
        $this->audit->record('docker.firewall_sync', $s, ['open_ports' => count($params['open_ports'])], 'success', $s->id, $job->id, $actor);

        return $job;
    }

    /** @param list<string> $types */
    public function ensureNoActiveJob(Server $s, array $types): void
    {
        $busy = Job::query()->where('server_id', $s->id)->whereIn('type', $types)->whereIn('state', ['queued', 'running'])
            ->where('created_at', '>=', Carbon::now()->subHour())->exists();
        if ($busy) {
            throw new ApiProblem(409, 'resource_locked', 'Đang có job khác', 'Chờ job trước kết thúc rồi thử lại.');
        }
    }
}
