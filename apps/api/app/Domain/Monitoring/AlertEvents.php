<?php

declare(strict_types=1);

namespace App\Domain\Monitoring;

use App\Domain\Notifications\Notifier;
use App\Models\Alert;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Sự kiện chuyển trạng thái cảnh báo (firing, nhắc lại, resolved) → thông báo (D-102/D-104).
 * 11.4: in-app cho SUPER_ADMIN, ADMIN có server/account trong phạm vi và USER chủ account (chỉ sự kiện dành cho USER).
 * Mức critical luôn có in-app (in_app_locked). Nội dung không chứa bí mật.
 */
class AlertEvents
{
    /** Metric mà USER chủ account cũng nhận (ADR 0049 §4). */
    public const USER_METRICS = ['uptime_down', 'cert_days', 'backup_failed', 'quota_disk_pct'];

    public function __construct(protected readonly Notifier $notifier) {}

    /** @param  'firing'|'repeat'|'resolved'  $event */
    public function emit(Alert $alert, string $event): void
    {
        $rule = $alert->rule;
        if (! in_array('in_app', $rule->channels, true) && $alert->severity !== 'critical') {
            return;
        }
        $prefix = match ($event) {
            'firing' => 'Cảnh báo',
            'repeat' => 'Nhắc lại',
            default => 'Đã hết',
        };
        $title = mb_substr("$prefix: {$rule->name}", 0, 200);
        $body = (string) $alert->message;
        $severity = $event === 'resolved' ? 'info' : $alert->severity;
        foreach ($this->admins($alert) as $u) {
            $this->notifier->notify($u, "alert.$event", $title, $body, $severity, '/monitoring/alerts');
        }
        if ($alert->hosting_account_id !== null && in_array($rule->metric, self::USER_METRICS, true)) {
            $owner = User::query()->whereIn('id', DB::table('hosting_accounts')->where('id', $alert->hosting_account_id)
                ->select('owner_user_id'))->where('status', 'active')->first();
            if ($owner instanceof User) {
                $this->notifier->notify($owner, "alert.$event", $title, $body, $severity, '/monitoring');
            }
        }
    }

    /** @return iterable<User> */
    protected function admins(Alert $alert): iterable
    {
        $role = fn (string $key) => DB::table('user_roles')->join('roles', 'roles.id', '=', 'user_roles.role_id')
            ->where('roles.key', $key)->select('user_roles.user_id');

        return User::query()->where('realm', 'admin')->where('status', 'active')
            ->where(function ($w) use ($role, $alert): void {
                $w->whereIn('id', $role('SUPER_ADMIN'));
                $w->orWhere(fn ($a) => $a->whereIn('id', $role('ADMIN'))->whereIn('id', DB::table('user_scopes')
                    ->where(fn ($s) => $s->where(fn ($x) => $x->where('scope_type', 'server')->where('scope_id', $alert->server_id ?? 0))
                        ->orWhere(fn ($x) => $x->where('scope_type', 'hosting_account')->where('scope_id', $alert->hosting_account_id ?? 0)))
                    ->select('user_id')));
            })->get();
    }
}
