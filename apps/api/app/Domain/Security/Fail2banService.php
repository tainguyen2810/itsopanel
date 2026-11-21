<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\Job;
use App\Models\SecuritySetting;
use App\Models\Server;
use App\Models\User;

/** Fail2ban (ADR 0024 §4): 3 jail cố định, ignoreip = IP allowlist Admin; danh sách cấm đọc trực tiếp từ agent. */
final class Fail2banService
{
    public const JAILS = ['sshd', 'itso-panel', 'pure-ftpd'];

    public const DEFAULT_JAIL = ['enabled' => true, 'bantime_sec' => 3600, 'findtime_sec' => 600, 'maxretry' => 5];

    public function __construct(private readonly AgentClient $agent, private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit) {}

    /** @return array{enabled: bool, jails: list<array{name: string, enabled: bool, bantime_sec: int, findtime_sec: int, maxretry: int}>} */
    public function desired(Server $s): array
    {
        $f = SecuritySetting::for($s->id)->fail2ban;
        $byName = [];
        foreach ((array) ($f['jails'] ?? []) as $j) {
            if (is_array($j) && in_array($j['name'] ?? null, self::JAILS, true)) {
                $byName[$j['name']] = $j;
            }
        }
        $jails = [];
        foreach (self::JAILS as $name) {
            $j = array_merge(self::DEFAULT_JAIL, $byName[$name] ?? []);
            $jails[] = ['name' => $name, 'enabled' => (bool) $j['enabled'], 'bantime_sec' => (int) $j['bantime_sec'],
                'findtime_sec' => (int) $j['findtime_sec'], 'maxretry' => (int) $j['maxretry']];
        }

        return ['enabled' => (bool) ($f['enabled'] ?? true), 'jails' => $jails];
    }

    /** @return array<string, mixed> Fail2banSettings */
    public function get(Server $s): array
    {
        $d = $this->desired($s);
        $counts = [];
        foreach ($this->status($s)['jails'] ?? [] as $j) {
            $counts[(string) ($j['name'] ?? '')] = (int) ($j['total_banned'] ?? 0);
        }
        foreach ($d['jails'] as &$j) {
            $j['banned_count'] = $counts[$j['name']] ?? 0;
        }

        return $d + ['updated_at' => SecuritySetting::for($s->id)->updated_at->toIso8601String()];
    }

    /** @param  array<string, mixed>  $patch */
    public function update(Server $s, User $actor, array $patch, ?string $idem = null): Job
    {
        $d = $this->desired($s);
        if (array_key_exists('enabled', $patch)) {
            $d['enabled'] = (bool) $patch['enabled'];
        }
        foreach ((array) ($patch['jails'] ?? []) as $i => $in) {
            $name = is_array($in) ? ($in['name'] ?? null) : null;
            $k = array_search($name, self::JAILS, true);
            if ($k === false) {
                throw ApiProblem::field("jails.$i.name", 'Jail phải là sshd, itso-panel hoặc pure-ftpd.');
            }
            foreach (['bantime_sec' => [60, 2592000], 'findtime_sec' => [60, 86400], 'maxretry' => [1, 100]] as $f => [$lo, $hi]) {
                if (array_key_exists($f, $in) && (! is_int($in[$f]) || $in[$f] < $lo || $in[$f] > $hi)) {
                    throw ApiProblem::field("jails.$i.$f", "$f phải trong khoảng {$lo}–{$hi}.");
                }
            }
            $d['jails'][$k] = array_merge($d['jails'][$k], array_intersect_key($in, self::DEFAULT_JAIL));
        }
        $set = SecuritySetting::for($s->id);
        $set->fail2ban = $d;
        $set->save();
        $job = $this->jobs->dispatch((new JobSpec('fail2ban.update', $s, $s->id))->step('fail2ban.apply', [
            'enabled' => $d['enabled'], 'jails' => $d['jails'], 'ignoreip' => SecurityContext::adminAllowlist()]), $actor, $idem);
        $this->audit->record('fail2ban.update', $s, $d, 'success', $s->id, $job->id, $actor);

        return $job;
    }

    /** @return array<string, mixed> kết quả fail2ban.status (rỗng nếu agent không trả lời) */
    public function status(Server $s): array
    {
        try {
            $r = $this->agent->forServer($s->id)->call('fail2ban.status', [], null, null, 10.0);
        } catch (AgentUnavailable) {
            return [];
        }

        return $r->ok ? (array) $r->data : [];
    }

    /** @return list<array<string, mixed>> Fail2banBan */
    public function bans(Server $s): array
    {
        $out = [];
        foreach ($this->status($s)['jails'] ?? [] as $j) {
            foreach ((array) ($j['banned'] ?? []) as $b) {
                $out[] = ['server' => ['uuid' => $s->uuid, 'name' => $s->name], 'jail' => (string) $j['name'],
                    'ip' => (string) $b['ip'], 'banned_at' => (string) $b['banned_at'], 'expires_at' => $b['expires_at'] ?? null];
            }
        }

        return $out;
    }

    public function unban(Server $s, User $actor, string $jail, string $ip, ?string $idem = null): Job
    {
        $job = $this->jobs->dispatch((new JobSpec('fail2ban.unban', $s, $s->id, 2, 60))
            ->step('fail2ban.unban', ['jail' => $jail, 'ip' => $ip]), $actor, $idem);
        $this->audit->record('fail2ban.unban', $s, ['jail' => $jail, 'ip' => $ip], 'success', $s->id, $job->id, $actor);

        return $job;
    }
}
