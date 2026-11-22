<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

use App\Models\Certificate;
use App\Models\HostingAccount;
use App\Models\Job;
use App\Models\UptimeCheck;
use App\Models\Website;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;

/**
 * Sự kiện nghiệp vụ gửi cả USER chủ account (ADR 0049 §4): quota 80 %/100 %, chứng chỉ 14/7/1 ngày + gia hạn lỗi,
 * backup lỗi, account khóa/mở, website down/up. (WordPress hoàn tác: WordPressJobHandler qua Notifier.)
 * Nội dung không chứa bí mật; link theo realm.
 */
final class UserEvents
{
    public const QUOTA_LEVELS = [100, 80];

    public const CERT_DAYS = [14, 7, 1];

    public function __construct(private readonly NotificationDispatcher $dispatcher) {}

    /** Mức dùng disk vượt 80 % / 100 % (báo một lần mỗi mức, xuống dưới 75 % thì đặt lại). */
    public function quota(HostingAccount $a, float $diskPct): void
    {
        $key = "itso:notify:quota:{$a->id}";
        $last = (int) Cache::get($key, 0);
        $level = 0;
        foreach (self::QUOTA_LEVELS as $l) {
            if ($diskPct >= $l) {
                $level = $l;
                break;
            }
        }
        if ($level === 0) {
            if ($last > 0 && $diskPct < 75) {
                Cache::forget($key);
            }

            return;
        }
        if ($level <= $last) {
            return;
        }
        Cache::put($key, $level, now()->addDays(30));
        $pct = rtrim(rtrim(number_format($diskPct, 1, ',', '.'), '0'), ',');
        $full = $level >= 100;
        $this->dispatcher->event($full ? 'quota.exceeded' : 'quota.warning',
            $full ? "Account {$a->username} đã dùng hết dung lượng" : "Account {$a->username} đã dùng {$pct}% dung lượng",
            $full ? "Dung lượng đã đạt {$pct}% giới hạn gói; ghi file mới có thể lỗi. Dọn bớt dữ liệu hoặc nâng gói."
                : "Dung lượng đã đạt {$pct}% giới hạn gói.",
            null, ['account_id' => $a->id], ['admin' => "/hosting-accounts/{$a->uuid}", 'portal' => "/hosting-accounts/{$a->uuid}"]);
    }

    /** Chứng chỉ sắp hết hạn: báo một lần ở mỗi mốc 14/7/1 ngày (gọi hằng ngày). */
    public function certificateExpiring(Certificate $c, ?Carbon $now = null): bool
    {
        $now ??= Carbon::now();
        if ($c->not_after === null || $c->not_after->lte($now)) {
            return false;
        }
        $days = (int) ceil($now->diffInSeconds($c->not_after, true) / 86400);
        $mark = null;
        foreach (self::CERT_DAYS as $d) {
            if ($days <= $d) {
                $mark = $d;
            }
        }
        if ($mark === null) {
            return false;
        }
        $key = "itso:notify:cert:{$c->id}:{$mark}:".$c->not_after->getTimestamp();
        if (! Cache::add($key, 1, now()->addDays(20))) {
            return false;
        }
        $w = $c->website_id !== null ? Website::withTrashed()->find($c->website_id) : null;
        $site = $w->primary_domain ?? ($c->domains[0] ?? $c->uuid);
        $this->dispatcher->event('certificate.expiring', "Chứng chỉ $site hết hạn sau $days ngày",
            'Hết hạn: '.$c->not_after->toDateString().'.'.($c->auto_renew ? ' Tự gia hạn đang bật; kiểm tra nếu vẫn nhận thông báo này.' : ' Tự gia hạn đang tắt.'),
            $mark === 1 ? 'high' : null, ['server_id' => $c->server_id, 'account_id' => $w?->hosting_account_id],
            ['admin' => $w !== null ? "/websites/{$w->uuid}/ssl" : '/ssl', 'portal' => $w !== null ? "/websites/{$w->uuid}" : null]);

        return true;
    }

    public function certificateRenewFailed(Job $job, Certificate $c, string $msg): void
    {
        $w = $c->website_id !== null ? Website::withTrashed()->find($c->website_id) : null;
        $site = $w->primary_domain ?? ($c->domains[0] ?? $c->uuid);
        $this->dispatcher->event('certificate.renew_failed', "Gia hạn chứng chỉ thất bại: $site",
            mb_substr($msg, 0, 300).' Hết hạn: '.($c->not_after?->toDateString() ?? '?').'.', null,
            ['server_id' => $c->server_id, 'account_id' => $w?->hosting_account_id],
            ['admin' => '/jobs/'.$job->uuid, 'portal' => $w !== null ? "/websites/{$w->uuid}" : null]);
    }

    public function backupFailed(Job $job, ?int $accountId): void
    {
        $label = $accountId !== null ? (HostingAccount::withTrashed()->whereKey($accountId)->value('username') ?? '') : '';
        $this->dispatcher->event('backup.failed', 'Backup thất bại'.($label !== '' ? ": $label" : ''),
            mb_substr((string) ($job->error_message ?? 'Job backup không hoàn tất.'), 0, 300), null,
            ['server_id' => $job->server_id, 'account_id' => $accountId],
            ['admin' => '/jobs/'.$job->uuid, 'portal' => '/backups']);
    }

    public function accountState(HostingAccount $a, bool $suspended): void
    {
        $this->dispatcher->event($suspended ? 'account.suspended' : 'account.unsuspended',
            $suspended ? "Account {$a->username} đã bị tạm khóa" : "Account {$a->username} đã được mở khóa",
            $suspended ? 'Website của account tạm ngừng phục vụ.'.($a->suspended_reason ? ' Lý do: '.mb_substr((string) $a->suspended_reason, 0, 200) : '')
                : 'Website của account hoạt động trở lại.',
            null, ['account_id' => $a->id], ['admin' => "/hosting-accounts/{$a->uuid}", 'portal' => "/hosting-accounts/{$a->uuid}"]);
    }

    public function websiteState(UptimeCheck $c, bool $down): void
    {
        $w = $c->website;
        $this->dispatcher->event($down ? 'website.down' : 'website.up',
            $down ? "Website {$w->primary_domain} không truy cập được" : "Website {$w->primary_domain} đã hoạt động lại",
            $down ? 'Kiểm tra uptime lỗi 3 lần liên tiếp'.($c->last_error ? ': '.mb_substr((string) $c->last_error, 0, 200) : '.') : 'Kiểm tra uptime đã thành công.',
            null, ['server_id' => $w->server_id, 'account_id' => $w->hosting_account_id],
            ['admin' => "/websites/{$w->uuid}", 'portal' => "/websites/{$w->uuid}"]);
    }
}
