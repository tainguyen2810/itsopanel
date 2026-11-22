<?php

declare(strict_types=1);

namespace App\Domain\Web;

use App\Domain\Audit\AuditLogger;
use App\Domain\Jobs\JobHandler;
use App\Domain\Notifications\UserEvents;
use App\Models\Certificate;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\Website;
use Illuminate\Support\Carbon;

/**
 * Observed state khi job certificate.* (và bước chứng chỉ trong website.create/update) kết thúc.
 * Cấp/tải lỗi → chứng chỉ failed, website trở lại ssl_mode cũ (agent không đổi vhost khi bước trước lỗi, hoặc đã hoàn tác
 * khi nginx -t lỗi). Gia hạn lỗi → chứng chỉ cũ vẫn dùng, ghi last_error, thông báo + audit.
 */
final class CertificateJobHandler implements JobHandler
{
    public function __construct(private readonly UserEvents $events, private readonly AuditLogger $audit) {}

    public function succeeded(Job $job): void
    {
        $c = Certificate::query()->where('last_job_id', $job->id)->lockForUpdate()->first();
        if ($job->type === 'certificate.delete') {
            $c?->delete();
        } else {
            self::settle($job, true);
        }
        $this->site($job, true);
    }

    public function failed(Job $job): void
    {
        $c = Certificate::query()->where('last_job_id', $job->id)->lockForUpdate()->first();
        $msg = mb_substr((string) ($job->error_message ?? $job->state), 0, 500);
        $failedOp = JobStep::query()->where('job_id', $job->id)->where('state', 'failed')->value('op');
        switch ($job->type) {
            case 'certificate.renew':
                if ($c !== null) {
                    $c->fill(['last_error' => $msg])->save();
                    $this->audit->record('certificate.renew', $c, ['error' => $msg], 'failure', $c->server_id, $job->id, null);
                    $this->notifyRenewFailed($job, $c, $msg);
                }

                return;
            case 'certificate.delete':
                if ($c !== null) {
                    $prev = $c->observed_facts['prev_status'] ?? 'ready';
                    // Vhost đã bỏ tls nhưng cert.remove lỗi: chứng chỉ không còn được dùng, để lại trạng thái failed.
                    $c->fill(['status' => $failedOp === 'cert.remove' ? 'failed' : (is_string($prev) ? $prev : 'ready'),
                        'last_error' => $msg])->save();
                }
                $this->site($job, $failedOp === 'cert.remove', $failedOp === 'cert.remove' ? null : ($c?->observed_facts['prev_ssl_mode'] ?? null));

                return;
            default:
                // Gỡ bản cũ lỗi sau khi vhost đã chuyển: chứng chỉ mới vẫn dùng được.
                if ($failedOp === 'cert.remove') {
                    self::settle($job, true);
                    $this->site($job, true);

                    return;
                }
                self::settle($job, false);
                $prev = $c?->observed_facts['prev_ssl_mode'] ?? null;
                $this->site($job, false, is_string($prev) ? $prev : null);
        }
    }

    /**
     * Cập nhật chứng chỉ của job theo kết quả bước cert.issue/cert.install; gỡ bản cũ đã thay. Gọi cả từ WebsiteJobHandler.
     */
    public static function settle(Job $job, bool $ok): void
    {
        $c = Certificate::query()->where('last_job_id', $job->id)->lockForUpdate()->first();
        if ($c === null) {
            return;
        }
        $step = JobStep::query()->where('job_id', $job->id)->whereIn('op', ['cert.issue', 'cert.install'])->orderBy('seq')->first();
        $res = $step?->state === 'succeeded' && is_array($step->result) ? $step->result : null;
        $facts = $c->observed_facts;
        if ($ok && $res !== null) {
            $c->fill(['status' => 'ready', 'issuer' => mb_substr((string) ($res['issuer'] ?? $c->issuer ?? ''), 0, 500),
                'not_before' => self::time($res['not_before'] ?? null) ?? $c->not_before,
                'not_after' => self::time($res['not_after'] ?? null) ?? $c->not_after,
                'observed_version' => $c->spec_version, 'observed_at' => Carbon::now(), 'last_error' => null, 'drift' => null]);
            Certificate::query()->where('website_id', $c->website_id)->where('id', '!=', $c->id)
                ->where('observed_facts->retired_by', $c->uuid)->delete();
        } elseif (! $ok) {
            if ($c->status !== 'ready') {
                $c->status = 'failed';
            }
            $c->last_error = mb_substr((string) ($job->error_message ?? $job->state), 0, 500);
            foreach (Certificate::query()->where('website_id', $c->website_id)->where('observed_facts->retired_by', $c->uuid)->get() as $o) {
                $f = $o->observed_facts;
                unset($f['retired_by']);
                $o->observed_facts = $f;
                $o->save();
            }
        }
        $c->observed_facts = $facts;
        $c->save();
    }

    /** Website của job (nếu job này có đổi vhost): observed theo kết quả; lỗi → trả ssl_mode cũ. */
    private function site(Job $job, bool $ok, ?string $prevMode = null): void
    {
        $w = Website::query()->where('last_job_id', $job->id)->lockForUpdate()->first();
        if ($w === null) {
            return;
        }
        if (! $ok && $prevMode !== null) {
            $w->ssl_mode = $prevMode;
        }
        $a = HostingAccount::withTrashed()->find($w->hosting_account_id);
        $w->fill(['spec_version' => $ok ? $w->spec_version : max(1, $w->observed_version), 'observed_version' => $ok ? $w->spec_version : $w->observed_version,
            'observed_at' => Carbon::now(), 'drift' => null,
            'status' => $a instanceof HostingAccount && WebsiteSpec::suspended($a) ? 'suspended' : 'ready'])->save();
    }

    private function notifyRenewFailed(Job $job, Certificate $c, string $msg): void
    {
        // Người yêu cầu đã được JobRunner báo; job của lịch gia hạn (không người yêu cầu) báo SUPER_ADMIN.
        if ($job->requested_by_user_id !== null) {
            return;
        }
        // SUPER_ADMIN, ADMIN trong phạm vi và USER chủ website (certificate.renew_failed, ADR 0049 §4).
        $this->events->certificateRenewFailed($job, $c, $msg);
    }

    private static function time(mixed $v): ?Carbon
    {
        if (! is_string($v) || $v === '') {
            return null;
        }
        try {
            return Carbon::parse($v);
        } catch (\Throwable) {
            return null;
        }
    }
}
