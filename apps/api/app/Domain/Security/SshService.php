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
use App\Models\SecuritySetting;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * SSH hardening (D-77, ADR 0024): tập khóa cố định, safe-apply như tường lửa. Đổi port: áp dụng tường lửa mở port
 * mới trước (cùng job), một lần ssh:confirm xác nhận cả hai.
 */
final class SshService
{
    public const DEFAULTS = ['port' => 22, 'password_authentication' => true, 'permit_root_login' => 'prohibit-password',
        'allow_groups' => [], 'max_auth_tries' => 6];

    public function __construct(private readonly SafeApply $safe, private readonly JobDispatcher $jobs,
        private readonly AuditLogger $audit) {}

    /** @return array<string, mixed> SshSettings */
    public function get(Server $s): array
    {
        $set = SecuritySetting::for($s->id);
        $facts = (array) ($set->audit_facts['sshd'] ?? []);
        $d = array_merge(self::DEFAULTS, array_intersect_key($facts, self::DEFAULTS), array_intersect_key($set->ssh, self::DEFAULTS));
        if (! in_array($d['permit_root_login'], ['no', 'prohibit-password'], true)) {
            $d['permit_root_login'] = 'prohibit-password';
        }
        $out = ['port' => (int) $d['port'], 'password_authentication' => (bool) $d['password_authentication'],
            'permit_root_login' => $d['permit_root_login'], 'allow_groups' => array_values((array) $d['allow_groups']),
            'max_auth_tries' => max(1, min(10, (int) $d['max_auth_tries']))];
        if (isset($set->ssh['admin_keys'])) {
            $out['admin_keys'] = (int) $set->ssh['admin_keys'];
        }

        return $out + ['updated_at' => $set->updated_at->toIso8601String()];
    }

    /** @param  array<string, mixed>  $patch  SshSettingsPatch đã validate */
    public function update(Server $s, User $actor, string $clientIp, array $patch, ?string $idem = null): Job
    {
        $cur = $this->get($s);
        $want = array_merge(array_intersect_key($cur, self::DEFAULTS), array_intersect_key($patch, self::DEFAULTS));
        $rollback = (int) $patch['rollback_after_sec'];
        $set = SecuritySetting::for($s->id);
        if ($want['password_authentication'] === false && array_key_exists('admin_keys', $set->ssh) && (int) $set->ssh['admin_keys'] === 0) {
            throw FirewallRuleset::lockout('Chưa có khóa SSH nào cho tài khoản quản trị: tắt đăng nhập mật khẩu sẽ khóa bạn khỏi máy chủ.');
        }
        $panel = SecurityContext::panelPort();
        if ($want['port'] === $panel) {
            throw ApiProblem::field('port', 'Cổng SSH trùng cổng panel.');
        }
        $portChange = $want['port'] !== $cur['port'];

        return DB::transaction(function () use ($s, $actor, $clientIp, $want, $cur, $rollback, $portChange, $panel, $idem): Job {
            $spec = new JobSpec('sshd.update', $s, $s->id, 3, 300);
            if ($portChange) {
                // Mở port mới (rule hệ thống) trước khi đổi sshd; port cũ vẫn mở tới khi xác nhận xong.
                $rules = FirewallRuleset::params(FirewallRule::query()->where('server_id', $s->id)->where('scope', 'host')->orderBy('priority')->get());
                $rules[] = ['priority' => 1, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'tcp',
                    'ports' => $cur['port'].','.$want['port'], 'source' => '0.0.0.0/0', 'comment' => 'itso: đổi cổng SSH'];
                usort($rules, fn (array $a, array $b): int => $a['priority'] <=> $b['priority']);
                FirewallRuleset::check($rules, (int) $want['port'], $panel, $clientIp);
                $fw = $this->safe->begin($s, 'firewall', $actor, $clientIp, ['rules' => $rules, 'ssh_port' => $want['port'],
                    'panel_port' => $panel, 'reason' => 'ssh_port'], null, $rollback);
                $spec->step('firewall.apply', FirewallService::applyParams($fw, $rules, (int) $want['port'], $panel, $clientIp, $rollback));
            }
            $a = $this->safe->begin($s, 'sshd', $actor, $clientIp, $want, array_intersect_key($cur, self::DEFAULTS), $rollback);
            $spec->step('sshd.config.apply', ['apply_id' => $a->uuid, 'port' => $want['port'],
                'password_authentication' => $want['password_authentication'], 'permit_root_login' => $want['permit_root_login'],
                'max_auth_tries' => $want['max_auth_tries'], 'login_grace_sec' => 60, 'x11_forwarding' => false,
                'agent_forwarding' => false, 'allow_groups' => array_values($want['allow_groups']),
                'admin_user' => (string) config('itso.security.ssh_admin_user', 'root'), 'client_ip' => $clientIp,
                'confirm_within_sec' => $rollback]);
            $job = $this->jobs->dispatch($spec, $actor, $idem);
            FirewallApply::query()->where('server_id', $s->id)->where('status', 'pending_confirm')->whereNull('job_id')
                ->update(['job_id' => $job->id]);
            $this->audit->record('sshd.update', $s, ['from' => array_intersect_key($cur, self::DEFAULTS), 'to' => $want,
                'rollback_after_sec' => $rollback], 'success', $s->id, $job->id, $actor);

            return $job;
        });
    }

    public function confirm(Server $s, User $actor, ?string $idem = null): Job
    {
        $a = $this->safe->pending($s, 'sshd');
        if ($a === null) {
            throw new ApiProblem(409, 'precondition_failed', 'Không có thay đổi chờ xác nhận',
                'Không có thay đổi SSH nào đang chờ (có thể đã quá hạn và được hoàn tác).');
        }
        $spec = new JobSpec('sshd.confirm', $s, $s->id, 2, 60);
        $fw = $this->safe->pending($s, 'firewall');
        if ($fw !== null && ($fw->spec['reason'] ?? null) === 'ssh_port' && $fw->job_id === $a->job_id) {
            $spec->step('firewall.confirm', ['apply_id' => $fw->uuid]);
        }
        $spec->step('sshd.config.confirm', ['apply_id' => $a->uuid]);
        $job = $this->jobs->dispatch($spec, $actor, $idem);
        $this->audit->record('sshd.confirm', $s, ['apply_uuid' => $a->uuid], 'success', $s->id, $job->id, $actor);

        return $job;
    }

    /**
     * Sau sshd.update thành công: ghi số khóa admin agent đếm được.
     *
     * @param  array<string, mixed>  $result
     */
    public static function rememberApplyResult(int $serverId, array $result): void
    {
        $set = SecuritySetting::for($serverId);
        if (isset($result['admin_keys'])) {
            $set->ssh = array_merge($set->ssh, ['admin_keys' => (int) $result['admin_keys']]);
            $set->save();
        }
    }

    /** Sau sshd.confirm thành công: desired = cấu hình đã xác nhận. */
    public static function confirmed(int $serverId, string $applyUuid): void
    {
        $a = FirewallApply::query()->where('uuid', $applyUuid)->first();
        if ($a === null) {
            return;
        }
        $set = SecuritySetting::for($serverId);
        $set->ssh = array_merge($set->ssh, array_intersect_key($a->spec, self::DEFAULTS));
        $set->updated_at = Carbon::now();
        $set->save();
    }
}
