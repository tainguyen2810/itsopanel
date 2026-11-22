<?php

declare(strict_types=1);

namespace App\Http\Presenters;

use App\Domain\Monitoring\UptimeService;
use App\Models\Alert;
use App\Models\AlertRule;
use App\Models\UptimeCheck;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/** Trình bày AlertRule, Alert, UptimeCheck theo contracts (D-102, D-105). */
final class MonitoringPresenter
{
    public const SCOPE_TABLES = ['server' => 'servers', 'hosting_account' => 'hosting_accounts', 'website' => 'websites'];

    public function __construct(private readonly UptimeService $uptime) {}

    /** @return array<string, mixed> */
    public function rule(AlertRule $r): array
    {
        $scope = $r->scope_id !== null ? DB::table(self::SCOPE_TABLES[$r->scope_type])->where('id', $r->scope_id)->value('uuid') : null;

        return ['uuid' => $r->uuid, 'name' => $r->name, 'metric' => $r->metric, 'scope_type' => $r->scope_type,
            'scope_uuid' => $scope !== null ? (string) $scope : null, 'operator' => $r->operator, 'threshold' => $r->threshold,
            'for_sec' => $r->duration_sec, 'severity' => $r->severity, 'channels' => $r->channels, 'enabled' => $r->enabled,
            'is_default' => $r->is_default, 'repeat_sec' => $r->repeat_sec,
            'firing_count' => Alert::query()->where('rule_id', $r->id)->where('state', 'firing')->count(),
            'created_at' => $r->created_at->toIso8601String(), 'updated_at' => $r->updated_at->toIso8601String()];
    }

    public static function ruleEtag(AlertRule $r): string
    {
        return '"'.sha1(json_encode($r->only(['uuid', 'name', 'metric', 'operator', 'threshold', 'duration_sec', 'repeat_sec', 'severity',
            'scope_type', 'scope_id', 'channels', 'enabled']), JSON_THROW_ON_ERROR)).'"';
    }

    /** @return array<string, mixed> */
    public function alert(Alert $a): array
    {
        [$type, $id] = $a->website_id !== null ? ['website', $a->website_id]
            : ($a->hosting_account_id !== null && $a->rule->scope_type === 'hosting_account' ? ['hosting_account', $a->hosting_account_id]
                : ['server', $a->server_id]);
        $uuid = (string) DB::table(self::SCOPE_TABLES[$type])->where('id', $id)->value('uuid');
        $iso = fn (?Carbon $c): ?string => $c?->toIso8601String();
        $acker = $a->ackedBy;

        return ['uuid' => $a->uuid, 'rule' => ['uuid' => $a->rule->uuid, 'name' => $a->rule->name], 'severity' => $a->severity,
            'state' => $a->state, 'resource' => ['type' => $type, 'uuid' => $uuid], 'value' => (float) ($a->value ?? 0),
            'started_at' => $a->started_at->toIso8601String(), 'resolved_at' => $iso($a->resolved_at), 'message' => (string) $a->message,
            'server' => $a->server !== null ? ['uuid' => $a->server->uuid, 'name' => $a->server->name] : null,
            'acknowledged_by' => $acker !== null ? ['uuid' => $acker->uuid, 'name' => $acker->name, 'email' => $acker->email] : null,
            'acknowledged_at' => $iso($a->acked_at), 'silenced_until' => $a->silenced() ? $iso($a->silenced_until) : null,
            'last_notified_at' => $iso($a->last_notified_at)];
    }

    /** @return array<string, mixed> */
    public function uptime(UptimeCheck $c): array
    {
        $w = $c->website;
        $iso = fn (?Carbon $x): ?string => $x?->toIso8601String();

        return ['uuid' => $c->uuid, 'website' => ['uuid' => $w->uuid, 'primary_domain' => $w->primary_domain],
            'url' => UptimeService::url($w, $c->path), 'interval_sec' => $c->interval_sec, 'last_status' => $c->last_status,
            'last_latency_ms' => $c->last_latency_ms, 'last_checked_at' => $iso($c->last_checked_at), 'enabled' => $c->enabled,
            'path' => $c->path, 'keyword' => $c->keyword, 'state' => $c->enabled ? $c->state : 'paused',
            'consecutive_failures' => $c->consecutive_failures, 'last_error' => $c->last_error,
            'cert_expires_at' => $iso($c->cert_expires_at), 'down_since' => $iso($c->down_since)] + $this->uptime->percentages($c);
    }

    public static function uptimeEtag(UptimeCheck $c): string
    {
        return '"'.sha1(json_encode($c->only(['uuid', 'path', 'keyword', 'interval_sec', 'enabled']), JSON_THROW_ON_ERROR)).'"';
    }

    /** @return array{at: string, ok: bool, status: int|null, latency_ms: int|null, error: string|null} */
    public static function result(\stdClass $r): array
    {
        return ['at' => Carbon::parse((string) $r->at)->setTimezone(config('app.timezone'))->toIso8601String(), 'ok' => (bool) $r->ok,
            'status' => $r->status !== null ? (int) $r->status : null, 'latency_ms' => $r->latency_ms !== null ? (int) $r->latency_ms : null,
            'error' => $r->error !== null ? (string) $r->error : null];
    }
}
