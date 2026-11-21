<?php

declare(strict_types=1);

namespace App\Auth;

use App\Domain\Setup\Settings;
use App\Exceptions\ApiProblem;
use App\Models\LoginAttempt;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;

/**
 * CAPTCHA proof-of-work tự host (D-81, ADR 0028 §1). Challenge = payload (ngẫu nhiên, realm, hạn, độ khó) + HMAC
 * bằng APP_KEY → không cần lưu trước; dùng một lần nhờ Cache::add (Redis) theo sha256 của challenge.
 * Lời giải: nonce sao cho sha256("challenge:nonce") có `difficulty` bit 0 đầu.
 */
final class Captcha
{
    public const TTL_SEC = 300;

    /** @return array{challenge: string, difficulty: int, expires_at: string} */
    public function issue(string $realm): array
    {
        $d = max(4, min(24, (int) config('itso.security.captcha_difficulty', 16)));
        $exp = Carbon::now()->addSeconds(self::TTL_SEC);
        $payload = self::b64(json_encode(['r' => bin2hex(random_bytes(16)), 'realm' => $realm, 'e' => $exp->getTimestamp(), 'd' => $d],
            JSON_THROW_ON_ERROR));

        return ['challenge' => $payload.'.'.self::b64(self::mac($payload)), 'difficulty' => $d, 'expires_at' => $exp->toIso8601String()];
    }

    /** Cần CAPTCHA khi IP hoặc email đã sai ≥ ngưỡng kể từ lần đúng gần nhất (0 = luôn cần). Chỉ realm portal. */
    public function required(string $realm, string $email, string $ip): bool
    {
        if ($realm !== Realm::PORTAL) {
            return false;
        }
        $n = (int) (Settings::get('security', 'portal_captcha_after_failures') ?? 3);
        if ($n <= 0) {
            return true;
        }
        $since = Carbon::now()->subMinutes((int) config('itso.auth.lockout.window_minutes', 60));
        foreach ([LoginAttempt::query()->where('realm', $realm)->where('email', $email), LoginAttempt::query()->where('ip_address', $ip)] as $q) {
            $lastOk = (clone $q)->where('success', true)->where('at', '>=', $since)->max('at');
            $from = $lastOk !== null ? Carbon::parse((string) $lastOk) : $since;
            if ((clone $q)->where('success', false)->where('at', '>', $from)->count() >= $n) {
                return true;
            }
        }

        return false;
    }

    /** Kiểm lời giải (nếu cần); thiếu/sai/hết hạn/dùng lại → 422 captcha_required. */
    public function enforce(string $realm, string $email, string $ip, mixed $solution): void
    {
        if (! $this->required($realm, $email, $ip)) {
            return;
        }
        if (! is_array($solution) || ! is_string($solution['challenge'] ?? null) || ! is_string($solution['nonce'] ?? null)) {
            throw self::problem('Cần giải CAPTCHA (GET /auth/captcha) để tiếp tục.');
        }
        $why = $this->check($realm, $solution['challenge'], $solution['nonce']);
        if ($why !== null) {
            throw self::problem($why);
        }
    }

    /** Trả lý do từ chối hoặc null nếu hợp lệ (và đánh dấu đã dùng). */
    public function check(string $realm, string $challenge, string $nonce): ?string
    {
        if (strlen($challenge) > 512 || preg_match('/^[0-9]{1,12}$/', $nonce) !== 1) {
            return 'CAPTCHA không hợp lệ.';
        }
        $parts = explode('.', $challenge);
        if (count($parts) !== 2 || ! hash_equals(self::b64(self::mac($parts[0])), $parts[1])) {
            return 'CAPTCHA không hợp lệ.';
        }
        $p = json_decode((string) base64_decode(strtr($parts[0], '-_', '+/'), true), true);
        if (! is_array($p) || ($p['realm'] ?? null) !== $realm || ! is_int($p['e'] ?? null) || ! is_int($p['d'] ?? null)) {
            return 'CAPTCHA không hợp lệ.';
        }
        if ($p['e'] < Carbon::now()->getTimestamp()) {
            return 'CAPTCHA đã hết hạn, lấy thử thách mới.';
        }
        if (! self::solves($challenge, $nonce, $p['d'])) {
            return 'Lời giải CAPTCHA sai.';
        }
        if (! Cache::add('itso:captcha:used:'.hash('sha256', $challenge), 1, self::TTL_SEC + 60)) {
            return 'CAPTCHA đã được dùng, lấy thử thách mới.';
        }

        return null;
    }

    public static function solves(string $challenge, string $nonce, int $difficulty): bool
    {
        $h = hash('sha256', $challenge.':'.$nonce, true);
        $full = intdiv($difficulty, 8);
        for ($i = 0; $i < $full; $i++) {
            if ($h[$i] !== "\0") {
                return false;
            }
        }
        $rest = $difficulty % 8;

        return $rest === 0 || (ord($h[$full]) >> (8 - $rest)) === 0;
    }

    private static function problem(string $detail): ApiProblem
    {
        return new ApiProblem(422, 'captcha_required', 'Cần xác minh CAPTCHA', $detail);
    }

    private static function mac(string $payload): string
    {
        return hash_hmac('sha256', 'itso-captcha|'.$payload, (string) config('app.key'), true);
    }

    private static function b64(string $raw): string
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }
}
