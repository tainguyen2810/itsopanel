<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Models\FirewallRule;
use App\Models\Job;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Nền bảo mật khi hoàn tất wizard (mục tiêu Phase 7: máy mới cài có điểm ≥ 80): rule web mặc định, allowlist từ
 * wizard, fail2ban (3 jail) + baseline FIM qua job `security.baseline`, tường lửa qua safe-apply (màn cuối wizard
 * gọi firewall:confirm; không xác nhận thì tự hoàn tác như mọi lần áp dụng).
 */
final class SecurityBaseline
{
    public const WEB_RULE = ['priority' => 100, 'action' => 'accept', 'direction' => 'in', 'protocol' => 'tcp',
        'port_range' => '80,443', 'source_cidr' => '0.0.0.0/0', 'comment' => 'Web (HTTP/HTTPS)', 'managed_by' => 'system'];

    public function __construct(private readonly JobDispatcher $jobs, private readonly Fail2banService $f2b,
        private readonly FirewallService $fw, private readonly AuditLogger $audit) {}

    /**
     * @param  list<string>  $allowlist  CIDR từ bước truy cập của wizard
     * @return array{baseline: Job, firewall: Job|null}
     */
    public function apply(Server $s, User $actor, string $clientIp, array $allowlist): array
    {
        DB::transaction(function () use ($s, $allowlist, $actor, $clientIp): void {
            if (! FirewallRule::query()->where('server_id', $s->id)->exists()) {
                FirewallRule::query()->create(['server_id' => $s->id] + self::WEB_RULE);
            }
            $cidrs = array_values(array_filter($allowlist, fn (string $c): bool => Net::cidr($c) !== null));
            $hasMe = collect($cidrs)->contains(fn (string $c): bool => Net::contains($c, $clientIp));
            if ($cidrs !== [] && $hasMe && ! DB::table('ip_allowlist')->where('scope', 'admin')->exists()) {
                foreach ($cidrs as $c) {
                    DB::table('ip_allowlist')->insertOrIgnore(['cidr' => $c, 'scope' => 'admin', 'note' => 'Wizard cài đặt',
                        'created_by_user_id' => $actor->id, 'created_at' => now(), 'updated_at' => now()]);
                }
            }
        });
        $d = $this->f2b->desired($s);
        $baseline = $this->jobs->dispatch((new JobSpec('security.baseline', $s, $s->id, 2, 1800))
            ->step('software.install', ['recipe' => 'fail2ban'])
            ->step('fail2ban.apply', ['enabled' => true, 'jails' => $d['jails'], 'ignoreip' => SecurityContext::adminAllowlist()])
            ->step('fim.baseline', []), $actor);
        $this->audit->record('security.baseline', $s, ['jails' => count($d['jails'])], 'success', $s->id, $baseline->id, $actor);
        $fw = null;
        if (app(SafeApply::class)->pending($s, 'firewall') === null) {
            $fw = $this->fw->apply($s, $actor, $clientIp, 300);
        }

        return ['baseline' => $baseline, 'firewall' => $fw];
    }
}
