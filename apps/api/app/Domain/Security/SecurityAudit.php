<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobDispatcher;
use App\Domain\Jobs\JobSpec;
use App\Infrastructure\Agent\AgentClient;
use App\Infrastructure\Agent\AgentUnavailable;
use App\Models\FimChange;
use App\Models\Job;
use App\Models\SecuritySetting;
use App\Models\Server;
use App\Models\User;
use Illuminate\Support\Carbon;

/**
 * security.audit → dữ kiện + điểm (ADR 0027), fim.check → fim_changes + sự kiện, fim.baseline qua job (step-up).
 * Gọi từ scheduler (itso:security-audit, itso:fim-check) và khi xem điểm lần đầu.
 */
final class SecurityAudit
{
    public function __construct(private readonly AgentClient $agent, private readonly SecurityScore $score,
        private readonly SecurityEvents $events, private readonly JobDispatcher $jobs, private readonly AuditLogger $audit) {}

    /** Chạy security.audit và tính điểm; agent không trả lời → tính điểm với dữ kiện cũ. */
    public function run(Server $s): SecuritySetting
    {
        $set = SecuritySetting::for($s->id);
        try {
            $r = $this->agent->forServer($s->id)->call('security.audit', [], null, null, 60.0);
            if ($r->ok) {
                $set->audit_facts = (array) $r->data;
                $set->audited_at = Carbon::now();
            }
        } catch (AgentUnavailable) {
            // giữ dữ kiện cũ
        }

        return $this->rescore($s, $set);
    }

    public function rescore(Server $s, ?SecuritySetting $set = null): SecuritySetting
    {
        $set ??= SecuritySetting::for($s->id);
        $res = $this->score->compute($s, $set->audit_facts);
        $set->score = $res['score'];
        $set->score_items = $res['items'];
        $set->scored_at = Carbon::now();
        $set->save();

        return $set;
    }

    /** Dữ kiện chưa có hoặc cũ hơn 1 giờ → chạy lại. */
    public function fresh(Server $s): SecuritySetting
    {
        $set = SecuritySetting::for($s->id);
        if ($set->audited_at === null || $set->audited_at->lt(Carbon::now()->subHour())) {
            return $this->run($s);
        }

        return $set->scored_at === null ? $this->rescore($s, $set) : $set;
    }

    /** fim.check: ghi thay đổi mới (bỏ trùng với thay đổi chưa xử lý), sự kiện high nếu có. Trả số thay đổi mới. */
    public function fimCheck(Server $s): int
    {
        try {
            $r = $this->agent->forServer($s->id)->call('fim.check', [], null, null, 120.0);
        } catch (AgentUnavailable) {
            return 0;
        }
        if (! $r->ok) {
            return 0;
        }
        $new = 0;
        $paths = [];
        foreach ((array) ($r->data['changes'] ?? []) as $c) {
            $dup = FimChange::query()->where('server_id', $s->id)->where('path', (string) $c['path'])
                ->where('change', (string) $c['change'])->whereNull('acknowledged_at')
                ->where(fn ($q) => isset($c['new_sha256']) ? $q->where('new_sha256', $c['new_sha256']) : $q->whereNull('new_sha256'))->exists();
            if ($dup) {
                continue;
            }
            FimChange::query()->create(['server_id' => $s->id, 'path' => mb_substr((string) $c['path'], 0, 4096),
                'change' => (string) $c['change'], 'old_sha256' => $c['old_sha256'] ?? null, 'new_sha256' => $c['new_sha256'] ?? null,
                'mode' => isset($c['mode']) ? (int) $c['mode'] : null, 'owner' => $c['owner'] ?? null, 'detected_at' => Carbon::now()]);
            $new++;
            if (count($paths) < 5) {
                $paths[] = (string) $c['path'];
            }
        }
        $set = SecuritySetting::for($s->id);
        $set->fim_checked_at = Carbon::now();
        if (is_string($r->data['baseline_at'] ?? null)) {
            $set->fim_baseline_at = Carbon::parse($r->data['baseline_at']);
        }
        $set->save();
        if ($new > 0) {
            $this->events->record('fim.changed', 'high', "$new file hệ thống thay đổi so với baseline: ".implode(', ', $paths)
                .($new > count($paths) ? '…' : ''), $s->id, null, null, ['count' => $new]);
        }

        return $new;
    }

    public function rebaseline(Server $s, User $actor, ?string $idem = null): Job
    {
        $job = $this->jobs->dispatch((new JobSpec('fim.baseline', $s, $s->id, 2, 600))->step('fim.baseline', []), $actor, $idem);
        $this->audit->record('fim.baseline', $s, null, 'success', $s->id, $job->id, $actor);

        return $job;
    }
}
