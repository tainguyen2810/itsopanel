<?php

declare(strict_types=1);

namespace App\Domain\Notifications;

use App\Jobs\SendNotification;
use App\Models\HostingAccount;
use App\Models\Notification;
use App\Models\NotificationChannel;
use App\Models\NotificationDelivery;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Định tuyến thông báo (D-104, ADR 0049): đối tượng nhận theo danh mục + vai trò + phạm vi, kênh theo tùy chọn từng người;
 * in-app ghi ngay, email cá nhân / kênh admin (email nhóm, Telegram, webhook) thành notification_deliveries và gửi qua
 * queue `notifications`. Giới hạn 30 tin/phút/kênh, phần vượt `blocked` (rate_limited) và được gộp thành tin tóm tắt.
 */
class NotificationDispatcher
{
    public const RATE_PER_MINUTE = 30;

    public const RATE_LIMITED = 'Vượt giới hạn 30 tin/phút của kênh; đã gộp vào tin tóm tắt.';

    public function __construct(private readonly NotificationPreferences $prefs) {}

    /**
     * Sự kiện nghiệp vụ: gửi tới mọi đối tượng trong danh mục (SUPER_ADMIN, ADMIN có server/account trong phạm vi, USER chủ account).
     *
     * @param  array{server_id?: int|null, account_id?: int|null}  $scope
     * @param  array{admin?: string|null, portal?: string|null}  $links
     */
    public function event(string $type, string $title, string $body, ?string $severity = null, array $scope = [],
        array $links = []): int
    {
        $def = NotificationCatalog::find($type);
        $severity ??= $def['severity'] ?? 'info';
        $audiences = $def['audiences'] ?? ['super_admin'];
        $serverId = $scope['server_id'] ?? null;
        $accountId = $scope['account_id'] ?? null;
        if ($serverId === null && $accountId !== null) {
            $serverId = HostingAccount::withTrashed()->whereKey($accountId)->value('server_id');
        }
        $n = 0;
        $seen = [];
        if (in_array('super_admin', $audiences, true) || in_array('admin', $audiences, true)) {
            foreach ($this->admins($serverId, $accountId, in_array('admin', $audiences, true)) as $u) {
                $seen[$u->id] = true;
                $this->toUser($u, $type, $title, $body, $severity, $links['admin'] ?? null);
                $n++;
            }
        }
        if (in_array('user', $audiences, true) && $accountId !== null) {
            $owner = User::query()->where('status', 'active')->where('realm', 'portal')
                ->whereIn('id', DB::table('hosting_accounts')->where('id', $accountId)->select('owner_user_id'))->first();
            if ($owner instanceof User && ! isset($seen[$owner->id])) {
                $this->toUser($owner, $type, $title, $body, $severity, $links['portal'] ?? null);
                $n++;
            }
        }

        return $n;
    }

    /**
     * Một người nhận: in-app / email cá nhân theo tùy chọn; telegram (chỉ realm admin) → các kênh Telegram đang bật, một lần
     * cho mỗi sự kiện. $only giới hạn thêm kênh (vd. kênh của rule cảnh báo).
     *
     * @param  list<string>|null  $only
     */
    public function toUser(User $u, string $type, string $title, string $body = '', string $severity = 'info',
        ?string $link = null, ?array $only = null): ?Notification
    {
        $severity = in_array($severity, Notifier::SEVERITIES, true) ? $severity : 'info';
        $chs = $this->prefs->effective($u, $type, $severity);
        if ($only !== null) {
            $locked = in_array('in_app', $chs, true) && ($severity === 'critical');
            $chs = array_values(array_intersect($chs, $only));
            if ($locked && ! in_array('in_app', $chs, true)) {
                $chs[] = 'in_app';
            }
        }
        $row = null;
        if (in_array('in_app', $chs, true)) {
            $row = Notification::query()->create([
                'user_id' => $u->id, 'type' => $type, 'title' => mb_substr($title, 0, 200), 'body' => mb_substr($body, 0, 2000),
                'data' => ['severity' => $severity, 'link' => $link], 'created_at' => Carbon::now(),
            ]);
        }
        if (in_array('email', $chs, true)) {
            $this->queue(new NotificationDelivery(['recipient_user_id' => $u->id]), $type, $title, $body, $severity, $link, null);
        }
        if ($u->realm === 'admin' && in_array('telegram', $chs, true)) {
            foreach (NotificationChannel::query()->where('type', 'telegram')->where('enabled', true)->get() as $c) {
                $dupe = NotificationDelivery::query()->where('channel_id', $c->id)->where('event_type', $type)
                    ->where('title', mb_substr($title, 0, 200))->where('created_at', '>=', Carbon::now()->subMinute())->exists();
                if (! $dupe) {
                    $this->toChannel($c, $type, $title, $body, $severity, $link);
                }
            }
        }

        return $row;
    }

    /**
     * Một kênh admin (rule cảnh báo, sự kiện, gửi thử).
     *
     * @param  array<string, mixed>  $extra
     */
    public function toChannel(NotificationChannel $c, string $type, string $title, string $body, string $severity,
        ?string $link = null, ?int $alertId = null, array $extra = [], bool $dispatch = true): NotificationDelivery
    {
        return $this->queue(new NotificationDelivery(['channel_id' => $c->id]), $type, $title, $body, $severity, $link, $alertId,
            $extra, $dispatch);
    }

    /** @param  array<string, mixed>  $extra */
    private function queue(NotificationDelivery $d, string $type, string $title, string $body, string $severity, ?string $link,
        ?int $alertId, array $extra = [], bool $dispatch = true): NotificationDelivery
    {
        $d->fill(['alert_id' => $alertId, 'event_type' => $type, 'severity' => $severity, 'title' => mb_substr($title, 0, 200),
            'payload' => ['body' => mb_substr($body, 0, 2000), 'link' => $link] + $extra, 'state' => 'queued', 'attempts' => 0]);
        $bypass = ($extra['summary'] ?? false) === true || ($extra['test'] ?? false) === true || ($extra['resend'] ?? false) === true;
        $limited = $d->channel_id !== null && ! $bypass
            && NotificationDelivery::query()->where('channel_id', $d->channel_id)->where('created_at', '>=', Carbon::now()->subMinute())
                ->where('state', '<>', 'blocked')->count() >= self::RATE_PER_MINUTE;
        if ($limited) {
            $d->state = 'blocked';
            $d->error = self::RATE_LIMITED;
            $d->payload = $d->payload + ['rate_limited' => true, 'summarized' => false];
        }
        $d->save();
        $d->refresh();
        if (! $limited && $dispatch) {
            SendNotification::dispatch($d->id);
        }

        return $d;
    }

    /** Gộp các tin bị giới hạn tần suất thành một tin tóm tắt cho mỗi kênh (gọi mỗi phút). */
    public function summarize(): int
    {
        $n = 0;
        $rows = NotificationDelivery::query()->where('state', 'blocked')->whereRaw("(payload->>'rate_limited')::boolean")
            ->whereRaw("NOT coalesce((payload->>'summarized')::boolean, false)")->where('created_at', '<', Carbon::now()->subSeconds(5))
            ->orderBy('id')->get()->groupBy('channel_id');
        foreach ($rows as $channelId => $group) {
            $c = NotificationChannel::query()->find($channelId);
            NotificationDelivery::query()->whereIn('id', $group->pluck('id'))
                ->update(['payload' => DB::raw("payload || '{\"summarized\": true}'::jsonb")]);
            if (! $c instanceof NotificationChannel || ! $c->enabled) {
                continue;
            }
            $sev = collect(Notifier::SEVERITIES)->last(fn (string $s) => $group->contains('severity', $s)) ?? 'info';
            $lines = $group->take(10)->map(fn (NotificationDelivery $d): string => '- '.$d->title)->implode("\n");
            $more = $group->count() > 10 ? "\n… và ".($group->count() - 10).' tin khác.' : '';
            $this->toChannel($c, 'notification.summary', 'Tóm tắt: '.$group->count().' thông báo bị gộp do vượt giới hạn tần suất',
                $lines.$more, $sev, '/monitoring/notifications', null, ['summary' => true]);
            $n++;
        }

        return $n;
    }

    /** Thử lại các lượt đến hạn mà job trễ bị mất (worker khởi động lại). */
    public function sweep(): int
    {
        $ids = NotificationDelivery::query()->where(fn ($q) => $q->where('state', 'retrying')->where('next_retry_at', '<=', Carbon::now()->subMinute())
            ->orWhere(fn ($x) => $x->where('state', 'queued')->where('created_at', '<=', Carbon::now()->subMinutes(5))))
            ->orderBy('id')->limit(200)->pluck('id');
        foreach ($ids as $id) {
            SendNotification::dispatch((int) $id);
        }

        return $ids->count();
    }

    /**
     * SUPER_ADMIN + (nếu $scoped) ADMIN có server/account trong phạm vi.
     *
     * @return iterable<User>
     */
    public function admins(?int $serverId, ?int $accountId, bool $scoped = true): iterable
    {
        $role = fn (string $key) => DB::table('user_roles')->join('roles', 'roles.id', '=', 'user_roles.role_id')
            ->where('roles.key', $key)->select('user_roles.user_id');

        return User::query()->where('realm', 'admin')->where('status', 'active')
            ->where(function ($w) use ($role, $serverId, $accountId, $scoped): void {
                $w->whereIn('id', $role('SUPER_ADMIN'));
                if ($scoped && ($serverId !== null || $accountId !== null)) {
                    $w->orWhere(fn ($a) => $a->whereIn('id', $role('ADMIN'))->whereIn('id', DB::table('user_scopes')
                        ->where(fn ($s) => $s->where(fn ($x) => $x->where('scope_type', 'server')->where('scope_id', $serverId ?? 0))
                            ->orWhere(fn ($x) => $x->where('scope_type', 'hosting_account')->where('scope_id', $accountId ?? 0)))
                        ->select('user_id')));
                }
            })->orderBy('id')->get();
    }
}
