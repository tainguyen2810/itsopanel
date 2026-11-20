<?php

declare(strict_types=1);

namespace App\Auth;

use App\Models\LoginAttempt;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;

/**
 * Khóa đăng nhập lũy tiến theo (realm, email) và theo IP, dựa trên bảng `login_attempts`.
 *
 * Đếm lần sai liên tiếp kể từ lần đúng gần nhất (trong cửa sổ `window_minutes`). Từ lần sai thứ
 * `threshold`, khóa 1, 2, 4… phút tính từ lần sai cuối (tối đa `max_lock_minutes`). IP dùng `ip_threshold`.
 */
final class LoginThrottle
{
    /** Số giây còn bị khóa (0 = được thử). */
    public function lockedFor(string $realm, string $email, string $ip): int
    {
        $cfg = (array) config('itso.auth.lockout');
        $since = Carbon::now()->subMinutes((int) ($cfg['window_minutes'] ?? 60));

        $byEmail = LoginAttempt::query()->where('realm', $realm)->where('email', $email);
        $byIp = LoginAttempt::query()->where('ip_address', $ip);

        return max(
            $this->lock($byEmail, $since, (int) ($cfg['threshold'] ?? 5), (int) ($cfg['max_lock_minutes'] ?? 60)),
            $this->lock($byIp, $since, (int) ($cfg['ip_threshold'] ?? 20), (int) ($cfg['max_lock_minutes'] ?? 60)),
        );
    }

    public function record(string $realm, string $email, string $ip, bool $success): void
    {
        LoginAttempt::query()->create([
            'realm' => $realm, 'email' => $email, 'ip_address' => $ip, 'success' => $success, 'at' => Carbon::now(),
        ]);
    }

    /** @param  Builder<LoginAttempt>  $q */
    private function lock($q, Carbon $since, int $threshold, int $maxMinutes): int
    {
        $lastOk = (clone $q)->where('success', true)->where('at', '>=', $since)->max('at');
        $from = $lastOk !== null ? Carbon::parse((string) $lastOk) : $since;
        $fails = (clone $q)->where('success', false)->where('at', '>', $from);
        $count = $fails->count();
        if ($count < $threshold) {
            return 0;
        }
        $lastFail = Carbon::parse((string) (clone $fails)->max('at'));
        $minutes = min($maxMinutes, 2 ** min(20, $count - $threshold));
        $until = $lastFail->copy()->addMinutes($minutes);

        return max(0, (int) ceil(Carbon::now()->diffInSeconds($until, false)));
    }
}
