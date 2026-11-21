<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Jobs\JobHandler;
use App\Models\FimChange;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\MalwareFinding;
use App\Models\MalwareScan;
use App\Models\QuarantineItem;
use App\Models\SecuritySetting;
use App\Models\WafSetting;
use Illuminate\Support\Carbon;

/** Cập nhật trạng thái Security Center khi job kết thúc (chạy trong transaction của JobRunner). */
final class SecurityJobHandler implements JobHandler
{
    public const TYPES = ['sshd.update', 'sshd.confirm', 'waf.update', 'malware.scan', 'malware.quarantine', 'malware.restore',
        'malware.delete', 'fim.baseline'];

    public function __construct(private readonly SecurityEvents $events) {}

    public function succeeded(Job $job): void
    {
        match ($job->type) {
            'sshd.update' => SshService::rememberApplyResult((int) $job->server_id, $this->result($job, 'sshd.config.apply')),
            'sshd.confirm' => SshService::confirmed((int) $job->server_id, (string) ($this->params($job, 'sshd.config.confirm')['apply_id'] ?? '')),
            'waf.update' => $this->waf($job),
            'malware.scan' => $this->scanDone($job),
            'malware.quarantine' => $this->quarantined($job),
            'malware.restore' => $this->restored($job),
            'malware.delete' => MalwareFinding::query()->whereKey($job->resource_id)->update(['action' => 'deleted']),
            'fim.baseline' => $this->baseline($job),
            default => null,
        };
    }

    public function failed(Job $job): void
    {
        if ($job->type === 'malware.scan') {
            MalwareScan::query()->where('job_id', $job->id)->update(['status' => $job->state, 'finished_at' => Carbon::now()]);
        }
    }

    /** @return array<string, mixed> */
    private function result(Job $job, string $op): array
    {
        $r = JobStep::query()->where('job_id', $job->id)->where('op', $op)->value('result');

        return is_array($r) ? $r : (is_string($r) ? (array) json_decode($r, true) : []);
    }

    /** @return array<string, mixed> */
    private function params(Job $job, string $op): array
    {
        $step = JobStep::query()->where('job_id', $job->id)->where('op', $op)->first();

        return $step !== null ? (array) $step->params_redacted : [];
    }

    private function waf(Job $job): void
    {
        $r = $this->result($job, 'waf.apply');
        WafSetting::query()->whereKey($job->resource_id)->update(['available' => (bool) ($r['available'] ?? true),
            'applied_at' => Carbon::now()]);
    }

    private function scanDone(Job $job): void
    {
        $scan = MalwareScan::query()->where('job_id', $job->id)->first();
        if ($scan === null) {
            return;
        }
        $r = $this->result($job, 'malware.scan');
        $findings = (array) ($r['findings'] ?? []);
        $now = Carbon::now();
        foreach ($findings as $f) {
            MalwareFinding::query()->create(['scan_id' => $scan->id, 'path' => (string) $f['path'], 'signature' => mb_substr((string) $f['signature'], 0, 200),
                'engine' => (string) $f['engine'], 'sha256' => (string) $f['sha256'], 'size' => (int) ($f['size'] ?? 0), 'found_at' => $now]);
        }
        $scan->status = 'succeeded';
        $scan->files_scanned = (int) ($r['files_scanned'] ?? 0);
        $scan->findings_count = count($findings);
        $scan->started_at = $job->started_at;
        $scan->finished_at = $now;
        $scan->save();
        if ($findings !== []) {
            $a = $scan->account;
            $this->events->record('malware.found', 'high', count($findings).' file nghi nhiễm trong account '.($a->username ?? '?')
                .': '.(string) $findings[0]['signature'], $scan->server_id, $scan->website_id, null,
                ['scan_uuid' => $scan->uuid, 'count' => count($findings)]);
        }
    }

    private function quarantined(Job $job): void
    {
        $f = MalwareFinding::query()->find($job->resource_id);
        if ($f === null) {
            return;
        }
        $p = $this->params($job, 'malware.quarantine');
        $r = $this->result($job, 'malware.quarantine');
        $uuid = (string) $p['item_uuid'];
        (new QuarantineItem)->forceFill(['uuid' => $uuid, 'finding_id' => $f->id, 'hosting_account_id' => $f->scan->hosting_account_id,
            'original_path' => $f->path, 'stored_path' => $uuid, 'sha256' => (string) ($r['sha256'] ?? $f->sha256),
            'signature' => $f->signature, 'size' => (int) ($r['size'] ?? $f->size), 'quarantined_at' => Carbon::now()])->save();
        $f->action = 'quarantined';
        $f->save();
    }

    private function restored(Job $job): void
    {
        $q = QuarantineItem::query()->find($job->resource_id);
        if ($q === null) {
            return;
        }
        $q->restored_at = Carbon::now();
        $q->save();
        if ($q->finding_id !== null) {
            MalwareFinding::query()->whereKey($q->finding_id)->update(['action' => 'restored']);
        }
    }

    private function baseline(Job $job): void
    {
        $set = SecuritySetting::for((int) $job->server_id);
        $set->fim_baseline_at = Carbon::now();
        $set->save();
        FimChange::query()->where('server_id', $job->server_id)->whereNull('acknowledged_at')
            ->update(['acknowledged_at' => Carbon::now(), 'acknowledged_by_user_id' => $job->requested_by_user_id]);
    }
}
