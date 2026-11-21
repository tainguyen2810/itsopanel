<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\V1\Security;

use App\Domain\Audit\AuditLogger;
use App\Domain\Security\Fail2banService;
use App\Domain\Security\FirewallRuleset;
use App\Domain\Security\Net;
use App\Domain\Security\SecurityAudit;
use App\Domain\Security\SecurityScore;
use App\Domain\Security\SshService;
use App\Exceptions\ApiProblem;
use App\Http\Support\Listing;
use App\Models\FimChange;
use App\Models\MalwareFinding;
use App\Models\SecurityEvent;
use App\Models\Server;
use App\Models\WafEvent;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/** /admin/security… (tag Security): tổng quan, điểm, sự kiện, SSH, fail2ban, FIM, IP allowlist. */
final class SecurityController extends SecurityBase
{
    public function overview(Request $request, SecurityAudit $audit): JsonResponse
    {
        $servers = $this->servers($request)->orderBy('servers.id')->get();
        $ids = $servers->pluck('id')->all();
        $scores = [];
        $checks = [];
        $updated = null;
        foreach ($servers as $s) {
            $set = $audit->fresh($s);
            $scores[] = (int) $set->score;
            foreach ((array) $set->score_items as $it) {
                if (($it['status'] ?? 'pass') !== 'pass') {
                    $sev = SecurityScore::WEIGHTS[$it['key']][2] ?? 'medium';
                    $checks[] = ['key' => (count($servers) > 1 ? $s->name.':' : '').$it['key'],
                        'title' => (count($servers) > 1 ? $s->name.': ' : '').$it['title'], 'status' => $it['status'],
                        'severity' => $it['status'] === 'warn' && $sev === 'critical' ? 'high' : $sev];
                }
            }
            $updated = $set->scored_at !== null && ($updated === null || $set->scored_at->gt($updated)) ? $set->scored_at : $updated;
        }
        $score = $scores === [] ? 0 : (int) min($scores);
        $since = Carbon::now()->subDay();
        $events = SecurityEvent::query()->whereIn('server_id', $ids ?: [0])->where('at', '>=', $since)
            ->select('severity', DB::raw('count(*) as n'))->groupBy('severity')->pluck('n', 'severity')->map(fn ($n): int => (int) $n)->all();
        $blocked = WafEvent::query()->where('action', 'blocked')->where('at', '>=', $since)
            ->whereIn('website_id', DB::table('websites')->whereIn('server_id', $ids ?: [0])->select('id'))
            ->distinct()->count('client_ip');
        $findings = MalwareFinding::query()->where('action', 'none')
            ->whereIn('scan_id', DB::table('malware_scans')->whereIn('server_id', $ids ?: [0])->select('id'))->count();

        return response()->json(['data' => ['score' => $score, 'grade' => SecurityScore::grade($score), 'checks' => $checks,
            'events_24h' => (object) $events, 'blocked_ips_24h' => $blocked, 'malware_findings_open' => $findings,
            'updated_at' => ($updated ?? Carbon::now())->toIso8601String()]]);
    }

    public function score(Request $request, SecurityAudit $audit): JsonResponse
    {
        $s = $this->serverQuery($request);
        $set = $audit->fresh($s);

        return response()->json(['data' => ['server' => self::ref($s), 'score' => (int) $set->score,
            'grade' => SecurityScore::grade((int) $set->score), 'items' => $set->score_items ?? [],
            'computed_at' => ($set->scored_at ?? Carbon::now())->toIso8601String()]]);
    }

    public function events(Request $request): JsonResponse
    {
        $q = SecurityEvent::query()->with(['server', 'website'])->whereIn('server_id', $this->servers($request)->select('servers.id'));
        $sev = $request->input('filter.severity');
        if ($sev !== null) {
            if (! in_array($sev, ['info', 'low', 'medium', 'high', 'critical'], true)) {
                throw ApiProblem::field('filter.severity', 'filter[severity] không hợp lệ.');
            }
            $q->where('severity', $sev);
        }
        Listing::search($request, $q, ['security_events.message', 'security_events.type']);

        return response()->json(Listing::page($request, $q, ['at' => 'security_events.at'], '-at', fn (SecurityEvent $e): array => self::event($e)));
    }

    public function acknowledge(Request $request, string $id, AuditLogger $audit): JsonResponse
    {
        $e = Str::isUuid($id) ? SecurityEvent::query()->where('uuid', $id)
            ->whereIn('server_id', $this->servers($request)->select('servers.id'))->first() : null;
        if (! $e instanceof SecurityEvent) {
            throw new NotFoundHttpException;
        }
        if ($e->acknowledged_at === null) {
            $e->acknowledged_at = Carbon::now();
            $e->acknowledged_by_user_id = $this->actor($request)->id;
            $e->save();
            $audit->record('security.event_ack', $e, ['type' => $e->type], 'success', $e->server_id, null, $this->actor($request));
        }

        return response()->json(['data' => self::event($e->refresh())]);
    }

    public function ssh(Request $request, SshService $ssh): JsonResponse
    {
        return response()->json(['data' => $ssh->get($this->serverQuery($request))]);
    }

    public function updateSsh(Request $request, SshService $ssh): JsonResponse
    {
        $s = $this->serverQuery($request);
        $in = $request->validate([
            'port' => ['sometimes', 'integer', 'between:1,65535'],
            'password_authentication' => ['sometimes', 'boolean'],
            'permit_root_login' => ['sometimes', 'in:no,prohibit-password'],
            'allow_groups' => ['sometimes', 'array', 'max:20'],
            'allow_groups.*' => ['string', 'regex:/^[a-z][a-z0-9-]{0,31}$/'],
            'max_auth_tries' => ['sometimes', 'integer', 'between:1,10'],
            'rollback_after_sec' => ['required', 'integer', 'between:30,600'],
        ]);
        self::only($request, ['port', 'password_authentication', 'permit_root_login', 'allow_groups', 'max_auth_tries', 'rollback_after_sec']);
        $this->ifMatch($request, '"'.sha1(json_encode($ssh->get($s), JSON_THROW_ON_ERROR)).'"');

        return $this->accepted($request, $ssh->update($s, $this->actor($request), $this->clientIp($request), $in));
    }

    public function confirmSsh(Request $request, SshService $ssh): JsonResponse
    {
        return $this->accepted($request, $ssh->confirm($this->serverQuery($request), $this->actor($request)));
    }

    public function fail2ban(Request $request, Fail2banService $f2b): JsonResponse
    {
        return response()->json(['data' => $f2b->get($this->serverQuery($request))]);
    }

    public function updateFail2ban(Request $request, Fail2banService $f2b): JsonResponse
    {
        $s = $this->serverQuery($request);
        $in = $request->validate([
            'enabled' => ['sometimes', 'boolean'],
            'jails' => ['sometimes', 'array', 'max:3'],
            'jails.*' => ['array:name,enabled,bantime_sec,findtime_sec,maxretry,banned_count'],
            'jails.*.name' => ['required', 'string'],
            'jails.*.enabled' => ['sometimes', 'boolean'],
            'jails.*.bantime_sec' => ['sometimes', 'integer'],
            'jails.*.findtime_sec' => ['sometimes', 'integer'],
            'jails.*.maxretry' => ['sometimes', 'integer'],
        ]);

        return $this->accepted($request, $f2b->update($s, $this->actor($request), $in));
    }

    public function bans(Request $request, Fail2banService $f2b): JsonResponse
    {
        $limit = $request->query('limit', '50');
        if (! is_string($limit) || ! ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 200) {
            throw ApiProblem::field('limit', 'limit phải là số nguyên 1–200.');
        }
        $rows = [];
        foreach ($this->servers($request)->orderBy('servers.id')->get() as $s) {
            array_push($rows, ...$f2b->bans($s));
        }
        $q = $request->query('q');
        if (is_string($q) && $q !== '') {
            $rows = array_values(array_filter($rows, fn (array $r): bool => str_contains($r['ip'], $q) || str_contains($r['jail'], $q)));
        }
        usort($rows, fn (array $a, array $b): int => strcmp($b['banned_at'], $a['banned_at']));

        return response()->json(['data' => array_slice($rows, 0, (int) $limit), 'meta' => ['next_cursor' => null, 'limit' => (int) $limit]]);
    }

    public function unban(Request $request, Fail2banService $f2b): JsonResponse
    {
        $in = $request->validate([
            'server' => ['required', 'uuid'],
            'jail' => ['required', 'in:sshd,itso-panel,pure-ftpd'],
            'ip' => ['required', 'string', 'max:45'],
        ]);
        if (Net::ip((string) $in['ip']) === null) {
            throw ApiProblem::field('ip', 'IP không hợp lệ.');
        }
        $s = $this->server($request, (string) $in['server']);

        return $this->accepted($request, $f2b->unban($s, $this->actor($request), (string) $in['jail'], (string) $in['ip']));
    }

    public function fimChanges(Request $request): JsonResponse
    {
        $q = FimChange::query()->with('server')->whereIn('server_id', $this->servers($request)->select('servers.id'));
        Listing::search($request, $q, ['fim_changes.path']);

        return response()->json(Listing::page($request, $q, ['detected_at' => 'fim_changes.detected_at', 'path' => 'fim_changes.path'],
            '-detected_at', fn (FimChange $c): array => ['uuid' => $c->uuid, 'server' => self::ref($c->server), 'path' => $c->path,
                'change' => $c->change, 'old_sha256' => $c->old_sha256, 'new_sha256' => $c->new_sha256,
                'detected_at' => $c->detected_at->toIso8601String(), 'acknowledged_at' => $c->acknowledged_at?->toIso8601String()]));
    }

    public function rebaselineFim(Request $request, string $id, SecurityAudit $audit): JsonResponse
    {
        return $this->accepted($request, $audit->rebaseline($this->server($request, $id), $this->actor($request)));
    }

    public function allowlist(): JsonResponse
    {
        return response()->json(['data' => self::allowlistData()]);
    }

    public function setAllowlist(Request $request, AuditLogger $audit): JsonResponse
    {
        $in = $request->validate([
            'entries' => ['present', 'array', 'max:100'],
            'entries.*' => ['array:cidr,note'],
            'entries.*.cidr' => ['required', 'string', 'max:64'],
            'entries.*.note' => ['present', 'string', 'max:120'],
            'updated_at' => ['sometimes', 'string'],
        ]);
        $ip = $this->clientIp($request);
        $entries = [];
        foreach ($in['entries'] as $i => $e) {
            $cidr = (string) $e['cidr'];
            if (Net::cidr($cidr) === null) {
                throw ApiProblem::field("entries.$i.cidr", 'CIDR không hợp lệ (octet ≤ 255, không có bit host).');
            }
            $norm = Net::normalize(str_contains($cidr, '/') ? $cidr : $cidr.(Net::isV6($cidr) ? '/128' : '/32'));
            $entries[$norm] = (string) $e['note'];
        }
        // Bất biến chống tự khóa (ADR 0028 §3): danh sách khác rỗng phải chứa IP hiện tại.
        if ($entries !== [] && ! collect(array_keys($entries))->contains(fn (string $c): bool => Net::contains($c, $ip))) {
            throw FirewallRuleset::lockout("Danh sách không chứa IP bạn đang dùng ($ip): lưu sẽ khóa bạn khỏi Admin Panel.");
        }
        $actor = $this->actor($request);
        $before = self::allowlistData()['entries'];
        DB::transaction(function () use ($entries, $actor): void {
            DB::table('ip_allowlist')->where('scope', 'admin')->delete();
            foreach ($entries as $cidr => $note) {
                DB::table('ip_allowlist')->insert(['cidr' => $cidr, 'scope' => 'admin', 'note' => $note,
                    'created_by_user_id' => $actor->id, 'created_at' => Carbon::now(), 'updated_at' => Carbon::now()]);
            }
        });
        $audit->record('security.ip_allowlist', null, ['from' => $before, 'to' => $entries, 'client_ip' => $ip], 'success', null, null, $actor);

        return response()->json(['data' => self::allowlistData()]);
    }

    /** @return array{entries: list<array{cidr: string, note: string}>, updated_at: string} */
    private static function allowlistData(): array
    {
        $rows = DB::table('ip_allowlist')->where('scope', 'admin')->orderBy('id')->get();
        $updated = $rows->max('updated_at');

        $entries = [];
        foreach ($rows as $r) {
            $entries[] = ['cidr' => (string) $r->cidr, 'note' => (string) ($r->note ?? '')];
        }

        return ['entries' => $entries,
            'updated_at' => Carbon::parse((string) ($updated ?? '2026-01-01T00:00:00Z'))->toIso8601String()];
    }

    /** @return array{uuid: string, name: string} */
    private static function ref(Server $s): array
    {
        return ['uuid' => $s->uuid, 'name' => $s->name];
    }

    /** @return array<string, mixed> SecurityEvent */
    private static function event(SecurityEvent $e): array
    {
        $s = $e->server;
        $w = $e->website;

        return ['uuid' => $e->uuid, 'type' => $e->type, 'severity' => $e->severity,
            'server' => $s !== null ? self::ref($s) : ['uuid' => '00000000-0000-4000-8000-000000000000', 'name' => '-'],
            'website' => $w !== null ? ['uuid' => $w->uuid, 'primary_domain' => $w->primary_domain] : null,
            'source_ip' => $e->source_ip, 'message' => $e->message, 'acknowledged_at' => $e->acknowledged_at?->toIso8601String(),
            'at' => $e->at->toIso8601String()];
    }
}
