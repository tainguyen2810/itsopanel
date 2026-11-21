<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Exceptions\ApiProblem;
use App\Models\FirewallApply;
use App\Models\FirewallRule;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Tường lửa nftables (D-76, ADR 0023): rule nháp trong firewall_rules → firewall:apply (safe-apply, tự hoàn tác)
 * → firewall:confirm bằng request mới. Bất biến chống tự khóa kiểm ở đây và ở agent.
 */
final class FirewallService
{
    public function __construct(private readonly SafeApply $safe, private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit) {}

    /** @param  array<string, mixed>  $in  FirewallRuleInput đã validate */
    public function create(Server $s, User $actor, string $clientIp, array $in): FirewallRule
    {
        $r = ['priority' => (int) $in['priority'], 'action' => $in['action'], 'direction' => $in['direction'],
            'protocol' => $in['protocol'], 'ports' => isset($in['ports']) && $in['ports'] !== '' ? (string) $in['ports'] : null,
            'source' => (string) $in['source'], 'comment' => (string) ($in['comment'] ?? '')];
        $err = FirewallRuleset::invalid($r);
        if ($err !== null) {
            throw ApiProblem::field(match (true) {
                str_starts_with($err, 'ports'), str_starts_with($err, 'icmp') => 'ports',
                str_starts_with($err, 'source') => 'source',
                str_starts_with($err, 'comment') => 'comment',
                default => 'priority',
            }, ucfirst($err).'.');
        }
        if (($in['enabled'] ?? true) && FirewallRuleset::locksOut($r, SecurityContext::sshPort($s), SecurityContext::panelPort(), $clientIp)) {
            throw FirewallRuleset::lockout('Rule này chặn cổng SSH/panel từ IP bạn đang dùng ('.$clientIp.').');
        }
        if (FirewallRule::query()->where('server_id', $s->id)->count() >= 500) {
            throw new ApiProblem(409, 'package_limit_reached', 'Quá nhiều rule', 'Mỗi máy chủ tối đa 500 rule.');
        }
        $rule = FirewallRule::query()->create(['server_id' => $s->id, 'priority' => $r['priority'], 'action' => $r['action'],
            'direction' => $r['direction'], 'protocol' => $r['protocol'], 'port_range' => $r['ports'],
            'source_cidr' => Net::normalize($r['source']), 'comment' => $r['comment'], 'enabled' => (bool) ($in['enabled'] ?? true)]);
        $this->audit->record('firewall.rule_create', $rule, $r, 'success', $s->id, null, $actor);

        return $rule;
    }

    public function delete(Server $s, User $actor, FirewallRule $rule): void
    {
        $rule->delete();
        $this->audit->record('firewall.rule_delete', $rule, ['priority' => $rule->priority, 'ports' => $rule->port_range],
            'success', $s->id, null, $actor);
    }

    /** @return list<array<string, mixed>> */
    public function rules(Server $s): array
    {
        return FirewallRuleset::params(FirewallRule::query()->where('server_id', $s->id)->orderBy('priority')->orderBy('id')->get());
    }

    /** @return array{server: array{uuid: string, name: string}, ruleset: string, rules_active: int, warnings: list<string>, lockout_risk: bool} */
    public function preview(Server $s, string $clientIp): array
    {
        $rules = $this->rules($s);
        $ssh = SecurityContext::sshPort($s);
        $panel = SecurityContext::panelPort();
        $warnings = [];
        $risk = false;
        foreach ($rules as $r) {
            if (FirewallRuleset::locksOut($r, $ssh, $panel, $clientIp)) {
                $risk = true;
                $warnings[] = "Rule ưu tiên {$r['priority']} chặn cổng SSH $ssh/panel $panel từ IP đang dùng $clientIp: sẽ bị từ chối khi áp dụng.";
            }
        }
        $safe = array_values(array_filter($rules, fn (array $r): bool => ! FirewallRuleset::locksOut($r, $ssh, $panel, $clientIp)));
        if (! $risk && ! collect($rules)->contains(fn (array $r): bool => $r['direction'] === 'in' && $r['action'] === 'accept'
            && in_array($r['ports'], ['80', '443', '80,443'], true))) {
            $warnings[] = 'Chưa có rule mở cổng web 80/443: website sẽ không truy cập được sau khi áp dụng.';
        }

        return ['server' => ['uuid' => $s->uuid, 'name' => $s->name], 'ruleset' => FirewallRuleset::render($safe, $ssh, $panel, $clientIp),
            'rules_active' => count($safe), 'warnings' => $warnings, 'lockout_risk' => $risk];
    }

    public function apply(Server $s, User $actor, string $clientIp, int $rollbackSec, ?string $idem = null): Job
    {
        $rules = $this->rules($s);
        $ssh = SecurityContext::sshPort($s);
        $panel = SecurityContext::panelPort();
        FirewallRuleset::check($rules, $ssh, $panel, $clientIp);

        return DB::transaction(function () use ($s, $actor, $clientIp, $rollbackSec, $rules, $ssh, $panel, $idem): Job {
            $prev = $this->safe->last($s, 'firewall');
            $a = $this->safe->begin($s, 'firewall', $actor, $clientIp, ['rules' => $rules, 'ssh_port' => $ssh, 'panel_port' => $panel],
                $prev?->status === 'confirmed' ? $prev->spec : null, $rollbackSec);
            $spec = (new JobSpec('firewall.apply', $s, $s->id, 3, 300))->step('firewall.apply', self::applyParams($a, $rules, $ssh, $panel, $clientIp, $rollbackSec));
            $job = $this->jobs->dispatch($spec, $actor, $idem);
            FirewallApply::query()->whereKey($a->id)->update(['job_id' => $job->id]);
            $this->audit->record('firewall.apply', $s, ['rules' => count($rules), 'rollback_after_sec' => $rollbackSec,
                'client_ip' => $clientIp, 'apply_uuid' => $a->uuid], 'success', $s->id, $job->id, $actor);

            return $job;
        });
    }

    /**
     * @param  list<array<string, mixed>>  $rules
     * @return array<string, mixed>
     */
    public static function applyParams(FirewallApply $a, array $rules, int $ssh, int $panel, string $clientIp, int $rollbackSec): array
    {
        return ['apply_id' => $a->uuid, 'rules' => $rules,
            'anti_lockout' => ['ssh_port' => $ssh, 'panel_port' => $panel, 'client_ip' => $clientIp],
            'confirm_within_sec' => $rollbackSec];
    }

    public function confirm(Server $s, User $actor, ?string $idem = null): Job
    {
        $a = $this->safe->pending($s, 'firewall');
        if ($a === null) {
            throw new ApiProblem(409, 'precondition_failed', 'Không có thay đổi chờ xác nhận',
                'Không có lần áp dụng tường lửa nào đang chờ (có thể đã quá hạn và được hoàn tác).');
        }
        $job = $this->jobs->dispatch((new JobSpec('firewall.confirm', $s, $s->id, 2, 60))
            ->step('firewall.confirm', ['apply_id' => $a->uuid]), $actor, $idem);
        $this->audit->record('firewall.confirm', $s, ['apply_uuid' => $a->uuid], 'success', $s->id, $job->id, $actor);

        return $job;
    }

    /** @return array{server: array{uuid: string, name: string}, state: string, applied_at: string|null, rollback_at: string|null, applied_by: array<string, string>|null, rules_active: int} */
    public function status(Server $s): array
    {
        $a = $this->safe->last($s, 'firewall');

        return ['server' => ['uuid' => $s->uuid, 'name' => $s->name],
            'state' => $a !== null ? $a->status : 'idle',
            'applied_at' => $a?->created_at->toIso8601String(),
            'rollback_at' => $a?->status === 'pending_confirm' ? $a->deadline_at->toIso8601String() : null,
            'applied_by' => $a?->user !== null ? ['uuid' => $a->user->uuid, 'name' => $a->user->name, 'email' => $a->user->email] : null,
            'rules_active' => $a !== null && $a->status !== 'rolled_back' ? count((array) ($a->spec['rules'] ?? [])) : 0];
    }
}
