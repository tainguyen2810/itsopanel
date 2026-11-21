<?php

declare(strict_types=1);

namespace App\Domain\Security;

use App\Domain\Notifications\Notifier;
use App\Models\SecurityEvent;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Ghi security_events; mức high/critical → thông báo in-app cho SUPER_ADMIN và ADMIN có máy chủ trong phạm vi
 * (ADR 0027 §4). Không đưa dữ liệu nhạy cảm (token, nội dung file) vào message/details.
 */
final class SecurityEvents
{
    public const NOTIFY = ['high', 'critical'];

    public function __construct(private readonly Notifier $notifier) {}

    /** @param  array<string, mixed>  $details */
    public function record(string $type, string $severity, string $message, ?int $serverId = null, ?int $websiteId = null,
        ?string $sourceIp = null, array $details = []): SecurityEvent
    {
        $e = SecurityEvent::query()->create(['type' => $type, 'severity' => $severity, 'message' => mb_substr($message, 0, 500),
            'server_id' => $serverId, 'website_id' => $websiteId, 'source_ip' => $sourceIp,
            'details' => $details === [] ? null : $details, 'at' => Carbon::now()]);
        if (in_array($severity, self::NOTIFY, true)) {
            foreach ($this->recipients($serverId) as $u) {
                $this->notifier->notify($u, 'security.'.$type, 'Bảo mật: '.mb_substr($message, 0, 150), $message, $severity,
                    '/security/events');
            }
        }

        return $e;
    }

    /** @return iterable<User> */
    private function recipients(?int $serverId): iterable
    {
        $role = fn (string $key) => DB::table('user_roles')->join('roles', 'roles.id', '=', 'user_roles.role_id')
            ->where('roles.key', $key)->select('user_roles.user_id');
        $q = User::query()->where('realm', 'admin')->where('status', 'active')
            ->where(function ($w) use ($role, $serverId): void {
                $w->whereIn('id', $role('SUPER_ADMIN'));
                if ($serverId !== null) {
                    $w->orWhere(fn ($a) => $a->whereIn('id', $role('ADMIN'))->whereIn('id', DB::table('user_scopes')
                        ->where('scope_type', 'server')->where('scope_id', $serverId)->select('user_id')));
                }
            });

        return $q->get();
    }
}
