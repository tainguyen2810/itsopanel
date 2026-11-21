<?php

declare(strict_types=1);

namespace App\Domain\Web;

use App\Domain\Jobs\JobHandler;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\JobStep;
use App\Models\Website;
use App\Models\WebsiteDomain;
use App\Models\WebsiteSetting;
use Illuminate\Support\Carbon;

/**
 * Observed state của website khi job website.* kết thúc. Agent đã hoàn tác khi `nginx -t`/`php-fpm -t` lỗi (D-67),
 * nên: thêm/gỡ domain lỗi → trả desired state về như cũ; sửa cấu hình lỗi → degraded + drift; tạo lỗi → failed.
 */
final class WebsiteJobHandler implements JobHandler
{
    public function succeeded(Job $job): void
    {
        CertificateJobHandler::settle($job, true);
        $w = $this->website($job);
        if ($w === null) {
            return;
        }
        if ($job->type === 'website.delete') {
            WebsiteDomain::query()->where('website_id', $w->id)->delete();
            WebsiteSetting::query()->where('website_id', $w->id)->delete();
            $w->observed_at = Carbon::now();
            $w->save();
            $w->delete();

            return;
        }
        $facts = $w->observed_facts;
        unset($facts['pending_domain']);
        $w->fill(['status' => $this->liveStatus($w), 'observed_version' => $w->spec_version, 'observed_at' => Carbon::now(),
            'drift' => null, 'observed_facts' => $facts])->save();
    }

    public function failed(Job $job): void
    {
        CertificateJobHandler::settle($job, false);
        $failedOp = JobStep::query()->where('job_id', $job->id)->where('state', 'failed')->value('op');
        $w = $this->website($job);
        if ($w === null) {
            return;
        }
        $msg = mb_substr((string) ($job->error_message ?? $job->state), 0, 300);
        $facts = $w->observed_facts;
        $pending = $facts['pending_domain'] ?? null;
        unset($facts['pending_domain']);
        $w->observed_facts = $facts;
        $w->observed_at = Carbon::now();
        switch ($job->type) {
            case 'website.create':
                if ($failedOp === 'cert.issue') {
                    // Site đã chạy HTTP; chỉ cấp chứng chỉ lỗi (thường do domain chưa trỏ về máy): xin lại sau.
                    $w->status = 'degraded';
                    $w->drift = ['ssl' => $msg];
                } else {
                    $w->status = 'failed';
                    $w->drift = ['apply' => $msg];
                }
                break;
            case 'website.domain.add':
            case 'website.domain.remove':
                // Agent giữ vhost cũ: đưa desired state về đúng như trên máy.
                if (is_array($pending) && is_int($pending['id'] ?? null)) {
                    $d = WebsiteDomain::withTrashed()->find($pending['id']);
                    if ($pending['op'] === 'add') {
                        $d?->forceDelete();
                    } else {
                        $d?->restore();
                    }
                }
                $w->spec_version = max($w->observed_version, 1);
                $w->drift = null;
                $w->status = $this->liveStatus($w);
                break;
            default:
                $w->status = 'degraded';
                $w->drift = ['apply' => $msg];
        }
        $w->save();
    }

    private function liveStatus(Website $w): string
    {
        $a = HostingAccount::withTrashed()->find($w->hosting_account_id);

        return $a instanceof HostingAccount && WebsiteSpec::suspended($a) ? 'suspended' : 'ready';
    }

    private function website(Job $job): ?Website
    {
        return Website::query()->where('last_job_id', $job->id)->lockForUpdate()->first();
    }
}
