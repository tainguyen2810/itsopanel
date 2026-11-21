<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Audit\AuditLogger;
use App\Domain\Hosting\ProvisioningService;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Infrastructure\Agent\AgentClient;
use App\Models\Job;
use App\Models\SecuritySetting;
use App\Models\Server;
use App\Models\User;
use App\Models\WafEvent;
use App\Models\WafSetting;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * WAF ModSecurity + OWASP CRS theo website (D-78, ADR 0025). API: enabled + mode detect|block ↔ DB
 * DetectionOnly|On|Off. Sự kiện đọc từ audit log JSON của agent theo con trỏ (itso:waf-events-sync).
 */
final class WafService
{
    /** Số lần chặn từ một IP trong một lượt đồng bộ → sự kiện bảo mật high. */
    public const BURST = 50;

    public function __construct(private readonly AgentClient $agent, private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit, private readonly SecurityEvents $events) {}

    public static function setting(Website $w): WafSetting
    {
        /** @var WafSetting */
        return WafSetting::query()->find($w->id) ?? new WafSetting(['website_id' => $w->id]);
    }

    /** @return array<string, mixed> WafSettings */
    public function present(Website $w): array
    {
        $s = self::setting($w);
        $blocked = WafEvent::query()->where('website_id', $w->id)->where('action', 'blocked')
            ->where('at', '>=', Carbon::now()->subDay())->count();

        return ['website' => ['uuid' => $w->uuid, 'primary_domain' => $w->primary_domain], 'enabled' => $s->mode !== 'Off',
            'mode' => $s->mode === 'On' ? 'block' : 'detect', 'paranoia_level' => $s->paranoia_level,
            'rule_exclusions' => array_map(fn (int $id): string => (string) $id, $s->rule_exclusions),
            'blocked_24h' => $blocked, 'updated_at' => ($s->updated_at ?? $w->updated_at)->toIso8601String()];
    }

    /** @param  array<string, mixed>  $patch  WafUpdate đã validate */
    public function update(Website $w, User $actor, array $patch, ?string $idem = null): Job
    {
        return DB::transaction(function () use ($w, $actor, $patch, $idem): Job {
            $s = self::setting($w);
            $enabled = (bool) ($patch['enabled'] ?? $s->mode !== 'Off');
            $mode = (string) ($patch['mode'] ?? ($s->mode === 'On' ? 'block' : 'detect'));
            $new = ! $enabled ? 'Off' : ($mode === 'block' ? 'On' : 'DetectionOnly');
            if ($new === 'DetectionOnly' && $s->mode !== 'DetectionOnly') {
                $s->detection_since = Carbon::now();
            }
            $s->mode = $new;
            if (isset($patch['paranoia_level'])) {
                $s->paranoia_level = (int) $patch['paranoia_level'];
            }
            if (isset($patch['rule_exclusions'])) {
                $s->rule_exclusions = array_values(array_unique(array_map('intval', (array) $patch['rule_exclusions'])));
            }
            $s->save();
            $a = $w->account;
            $job = $this->jobs->dispatch((new JobSpec('waf.update', $w, $w->server_id))->step('waf.apply', [
                'website_uuid' => $w->uuid, 'account' => ProvisioningService::ref($a), 'mode' => $s->mode,
                'paranoia_level' => $s->paranoia_level, 'rule_exclusions' => $s->rule_exclusions]), $actor, $idem);
            $this->audit->record('waf.update', $w, ['mode' => $s->mode, 'paranoia_level' => $s->paranoia_level,
                'rule_exclusions' => $s->rule_exclusions], 'success', $w->server_id, $job->id, $actor);

            return $job;
        });
    }

    /** Một lượt đồng bộ sự kiện của máy chủ; trả số sự kiện đã ghi. */
    public function sync(Server $server, int $maxPages = 10): int
    {
        $set = SecuritySetting::for($server->id);
        $uuids = Website::withTrashed()->where('server_id', $server->id)->pluck('id', 'uuid');
        $total = 0;
        $blockedByIp = [];
        for ($page = 0; $page < $maxPages; $page++) {
            $res = $this->agent->call('waf.events', ['cursor' => $set->waf_events_cursor, 'limit' => 500], null, null, 30.0);
            if (! $res->ok) {
                break;
            }
            $events = (array) ($res->data['events'] ?? []);
            $rows = [];
            foreach ($events as $e) {
                $wid = $uuids[(string) ($e['website_uuid'] ?? '')] ?? null;
                if ($wid === null) {
                    continue;
                }
                $rows[] = ['website_id' => $wid, 'rule_id' => (int) $e['rule_id'], 'message' => mb_substr((string) $e['message'], 0, 500),
                    'severity' => (string) $e['severity'], 'client_ip' => Net::ip((string) $e['client_ip']) !== null ? (string) $e['client_ip'] : null,
                    'method' => mb_substr((string) $e['method'], 0, 16), 'uri' => mb_substr((string) $e['uri'], 0, 2048),
                    'action' => (string) $e['action'], 'at' => Carbon::parse((string) $e['at'])];
                if ($e['action'] === 'blocked') {
                    $k = $wid.'|'.$e['client_ip'];
                    $blockedByIp[$k] = ($blockedByIp[$k] ?? 0) + 1;
                }
            }
            DB::transaction(function () use ($rows, $set, $res): void {
                foreach (array_chunk($rows, 200) as $chunk) {
                    WafEvent::query()->insert($chunk);
                }
                $set->waf_events_cursor = (string) ($res->data['next_cursor'] ?? $set->waf_events_cursor);
                $set->save();
            });
            $total += count($rows);
            if (count($events) < 500) {
                break;
            }
        }
        foreach ($blockedByIp as $k => $n) {
            if ($n >= self::BURST) {
                [$wid, $ip] = explode('|', $k, 2);
                $this->events->record('waf.burst', 'high', "WAF chặn $n request từ $ip trong một lượt đồng bộ.", $server->id,
                    (int) $wid, Net::ip($ip) !== null ? $ip : null, ['blocked' => $n]);
            }
        }

        return $total;
    }

    /** @return array<string, mixed> WafEvent */
    public static function presentEvent(WafEvent $e, Website $w): array
    {
        return ['uuid' => $e->uuid, 'website' => ['uuid' => $w->uuid, 'primary_domain' => $w->primary_domain],
            'rule_id' => $e->rule_id, 'message' => (string) $e->message, 'severity' => $e->severity,
            'client_ip' => (string) $e->client_ip, 'method' => (string) $e->method, 'uri' => (string) $e->uri,
            'action' => $e->action, 'at' => $e->at->toIso8601String()];
    }
}
