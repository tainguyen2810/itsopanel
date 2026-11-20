<?php

declare(strict_types=1);

namespace App\Auth;

use InvalidArgumentException;

/**
 * TOTP RFC 6238 (HOTP RFC 4226), mặc định SHA-1, 6 chữ số, bước 30 giây (tương thích app authenticator).
 */
final class Totp
{
    private const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    /** Secret 160 bit (khuyến nghị RFC 4226) dạng base32. */
    public static function generateSecret(): string
    {
        return self::base32Encode(random_bytes(20));
    }

    public static function timestep(int $unixTime, int $period = 30): int
    {
        return intdiv($unixTime, $period);
    }

    /** Mã tại bước thời gian `$step` cho khóa nhị phân `$key`. */
    public static function hotp(string $key, int $step, int $digits = 6, string $algo = 'sha1'): string
    {
        $counter = pack('N2', ($step >> 32) & 0xFFFFFFFF, $step & 0xFFFFFFFF);
        $hash = hash_hmac($algo, $counter, $key, true);
        $offset = ord($hash[strlen($hash) - 1]) & 0x0F;
        $bin = ((ord($hash[$offset]) & 0x7F) << 24)
            | ((ord($hash[$offset + 1]) & 0xFF) << 16)
            | ((ord($hash[$offset + 2]) & 0xFF) << 8)
            | (ord($hash[$offset + 3]) & 0xFF);

        return str_pad((string) ($bin % (10 ** $digits)), $digits, '0', STR_PAD_LEFT);
    }

    public static function at(string $base32Secret, int $unixTime, int $digits = 6, string $algo = 'sha1'): string
    {
        return self::hotp(self::base32Decode($base32Secret), self::timestep($unixTime), $digits, $algo);
    }

    /**
     * Bước thời gian khớp mã (cho phép lệch ±`$window` bước), hoặc null.
     * Bên gọi chặn dùng lại: chỉ chấp nhận bước lớn hơn bước đã dùng gần nhất.
     */
    public static function match(string $base32Secret, string $code, int $unixTime, int $window = 1): ?int
    {
        if (preg_match('/^\d{6}$/', $code) !== 1) {
            return null;
        }
        $key = self::base32Decode($base32Secret);
        $now = self::timestep($unixTime);
        for ($i = -$window; $i <= $window; $i++) {
            if (hash_equals(self::hotp($key, $now + $i), $code)) {
                return $now + $i;
            }
        }

        return null;
    }

    public static function uri(string $issuer, string $account, string $secret): string
    {
        $label = rawurlencode($issuer).':'.rawurlencode($account);

        return 'otpauth://totp/'.$label.'?'.http_build_query([
            'secret' => $secret, 'issuer' => $issuer, 'algorithm' => 'SHA1', 'digits' => 6, 'period' => 30,
        ], '', '&', PHP_QUERY_RFC3986);
    }

    public static function base32Encode(string $bin): string
    {
        $bits = '';
        foreach (str_split($bin) as $c) {
            $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::B32[(int) bindec(str_pad($chunk, 5, '0'))];
        }

        return $out;
    }

    public static function base32Decode(string $b32): string
    {
        $b32 = strtoupper(rtrim(str_replace(' ', '', $b32), '='));
        $bits = '';
        foreach (str_split($b32) as $c) {
            $v = strpos(self::B32, $c);
            if ($v === false) {
                throw new InvalidArgumentException('Secret base32 không hợp lệ.');
            }
            $bits .= str_pad(decbin($v), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $out .= chr((int) bindec($byte));
            }
        }

        return $out;
    }
}
